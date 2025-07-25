;; MicroSTX - Micropayment Channel System
;; Enables instant, low-fee STX transactions for content creators, gaming, and IoT

;; Contract constants
(define-constant CONTRACT-OWNER tx-sender)
(define-constant MIN-CHANNEL-AMOUNT u1000000) ;; 1 STX minimum
(define-constant MAX-CHANNEL-AMOUNT u1000000000000) ;; 1M STX maximum
(define-constant CHANNEL-TIMEOUT u144) ;; ~24 hours in blocks
(define-constant DISPUTE-TIMEOUT u144) ;; Dispute resolution period
(define-constant SETTLEMENT-FEE u10000) ;; 0.01 STX
(define-constant MAX-CHANNELS-PER-USER u100)

;; Error constants
(define-constant ERR-UNAUTHORIZED (err u100))
(define-constant ERR-INVALID-AMOUNT (err u101))
(define-constant ERR-CHANNEL-NOT-FOUND (err u102))
(define-constant ERR-CHANNEL-ALREADY-EXISTS (err u103))
(define-constant ERR-CHANNEL-CLOSED (err u104))
(define-constant ERR-INSUFFICIENT-BALANCE (err u105))
(define-constant ERR-INVALID-SIGNATURE (err u106))
(define-constant ERR-TIMEOUT-NOT-REACHED (err u107))
(define-constant ERR-DISPUTE-ACTIVE (err u108))
(define-constant ERR-INVALID-NONCE (err u109))
(define-constant ERR-MAX-CHANNELS-EXCEEDED (err u110))

;; Data variables
(define-data-var channel-counter uint u0)
(define-data-var total-locked uint u0)

;; Channel states
(define-constant CHANNEL-OPEN u1)
(define-constant CHANNEL-DISPUTED u2)
(define-constant CHANNEL-CLOSED u3)

;; Channel data structure
(define-map channels
    { channel-id: uint }
    {
        participant-a: principal,
        participant-b: principal,
        balance-a: uint,
        balance-b: uint,
        total-amount: uint,
        nonce: uint,
        state: uint,
        timeout-block: uint,
        created-at: uint,
        last-update: uint,
    }
)

;; Dispute tracking
(define-map channel-disputes
    { channel-id: uint }
    {
        initiator: principal,
        dispute-block: uint,
        proposed-balance-a: uint,
        proposed-balance-b: uint,
        dispute-nonce: uint,
    }
)

;; User channel tracking
(define-map user-channels
    { user: principal }
    { channel-count: uint }
)

;; Payment commitments for off-chain verification
(define-map payment-commitments
    {
        channel-id: uint,
        nonce: uint,
    }
    {
        balance-a: uint,
        balance-b: uint,
        commitment-hash: (buff 32),
        timestamp: uint,
    }
)

;; Helper functions
(define-private (get-next-channel-id)
    (let ((current-id (var-get channel-counter)))
        (var-set channel-counter (+ current-id u1))
        current-id
    )
)

(define-private (is-channel-participant
        (channel-id uint)
        (user principal)
    )
    (match (map-get? channels { channel-id: channel-id })
        channel-data (or
            (is-eq user (get participant-a channel-data))
            (is-eq user (get participant-b channel-data))
        )
        false
    )
)

(define-private (increment-user-channels (user principal))
    (let ((current-count (default-to u0
            (get channel-count (map-get? user-channels { user: user }))
        )))
        (map-set user-channels { user: user } { channel-count: (+ current-count u1) })
        true
    )
)

;; Public function: Open a new payment channel
(define-public (open-channel
        (participant-b principal)
        (amount-a uint)
        (amount-b uint)
    )
    (let (
            (channel-id (get-next-channel-id))
            (total-amount (+ amount-a amount-b))
            (user-a-count (default-to u0
                (get channel-count (map-get? user-channels { user: tx-sender }))
            ))
            (user-b-count (default-to u0
                (get channel-count
                    (map-get? user-channels { user: participant-b })
                )))
        )
        ;; Validations
        (asserts! (not (is-eq tx-sender participant-b)) ERR-UNAUTHORIZED)
        (asserts!
            (and
                (>= total-amount MIN-CHANNEL-AMOUNT)
                (<= total-amount MAX-CHANNEL-AMOUNT)
            )
            ERR-INVALID-AMOUNT
        )
        (asserts! (< user-a-count MAX-CHANNELS-PER-USER)
            ERR-MAX-CHANNELS-EXCEEDED
        )
        (asserts! (< user-b-count MAX-CHANNELS-PER-USER)
            ERR-MAX-CHANNELS-EXCEEDED
        )
        (asserts! (>= (stx-get-balance tx-sender) (+ amount-a SETTLEMENT-FEE))
            ERR-INSUFFICIENT-BALANCE
        )
        ;; Transfer funds to contract
        (try! (stx-transfer? amount-a tx-sender (as-contract tx-sender)))
        (try! (stx-transfer? SETTLEMENT-FEE tx-sender CONTRACT-OWNER))
        ;; Update state
        (var-set total-locked (+ (var-get total-locked) amount-a))
        (increment-user-channels tx-sender)
        (increment-user-channels participant-b)
        ;; Create channel
        (map-set channels { channel-id: channel-id } {
            participant-a: tx-sender,
            participant-b: participant-b,
            balance-a: amount-a,
            balance-b: amount-b,
            total-amount: total-amount,
            nonce: u0,
            state: CHANNEL-OPEN,
            timeout-block: (+ stacks-block-height CHANNEL-TIMEOUT),
            created-at: stacks-block-height,
            last-update: stacks-block-height,
        })
        (print {
            event: "channel-opened",
            channel-id: channel-id,
            participant-a: tx-sender,
            participant-b: participant-b,
            total-amount: total-amount,
        })
        (ok channel-id)
    )
)

;; Public function: Fund existing channel (participant B)
(define-public (fund-channel
        (channel-id uint)
        (amount uint)
    )
    (let ((channel-data (unwrap! (map-get? channels { channel-id: channel-id })
            ERR-CHANNEL-NOT-FOUND
        )))
        ;; Validations
        (asserts! (is-eq tx-sender (get participant-b channel-data))
            ERR-UNAUTHORIZED
        )
        (asserts! (is-eq (get state channel-data) CHANNEL-OPEN)
            ERR-CHANNEL-CLOSED
        )
        (asserts! (is-eq (get balance-b channel-data) u0)
            ERR-CHANNEL-ALREADY-EXISTS
        )
        (asserts! (is-eq amount (get balance-b channel-data)) ERR-INVALID-AMOUNT)
        (asserts! (>= (stx-get-balance tx-sender) amount)
            ERR-INSUFFICIENT-BALANCE
        )
        ;; Transfer funds
        (try! (stx-transfer? amount tx-sender (as-contract tx-sender)))
        (var-set total-locked (+ (var-get total-locked) amount))
        ;; Update channel
        (map-set channels { channel-id: channel-id }
            (merge channel-data {
                last-update: stacks-block-height,
                timeout-block: (+ stacks-block-height CHANNEL-TIMEOUT),
            })
        )
        (print {
            event: "channel-funded",
            channel-id: channel-id,
            amount: amount,
        })
        (ok true)
    )
)

;; Public function: Update channel state (off-chain payment)
(define-public (update-channel
        (channel-id uint)
        (new-balance-a uint)
        (new-balance-b uint)
        (nonce uint)
        (commitment-hash (buff 32))
    )
    (let ((channel-data (unwrap! (map-get? channels { channel-id: channel-id })
            ERR-CHANNEL-NOT-FOUND
        )))
        ;; Validations
        (asserts! (is-channel-participant channel-id tx-sender) ERR-UNAUTHORIZED)
        (asserts! (is-eq (get state channel-data) CHANNEL-OPEN)
            ERR-CHANNEL-CLOSED
        )
        (asserts! (> nonce (get nonce channel-data)) ERR-INVALID-NONCE)
        (asserts!
            (is-eq (+ new-balance-a new-balance-b)
                (get total-amount channel-data)
            )
            ERR-INVALID-AMOUNT
        )
        ;; Update channel state
        (map-set channels { channel-id: channel-id }
            (merge channel-data {
                balance-a: new-balance-a,
                balance-b: new-balance-b,
                nonce: nonce,
                last-update: stacks-block-height,
                timeout-block: (+ stacks-block-height CHANNEL-TIMEOUT),
            })
        )
        ;; Store payment commitment
        (map-set payment-commitments {
            channel-id: channel-id,
            nonce: nonce,
        } {
            balance-a: new-balance-a,
            balance-b: new-balance-b,
            commitment-hash: commitment-hash,
            timestamp: stacks-block-height,
        })
        (print {
            event: "channel-updated",
            channel-id: channel-id,
            nonce: nonce,
            balance-a: new-balance-a,
            balance-b: new-balance-b,
        })
        (ok true)
    )
)

;; Public function: Initiate dispute
(define-public (initiate-dispute
        (channel-id uint)
        (proposed-balance-a uint)
        (proposed-balance-b uint)
        (dispute-nonce uint)
    )
    (let ((channel-data (unwrap! (map-get? channels { channel-id: channel-id })
            ERR-CHANNEL-NOT-FOUND
        )))
        ;; Validations
        (asserts! (is-channel-participant channel-id tx-sender) ERR-UNAUTHORIZED)
        (asserts! (is-eq (get state channel-data) CHANNEL-OPEN)
            ERR-CHANNEL-CLOSED
        )
        (asserts!
            (is-eq (+ proposed-balance-a proposed-balance-b)
                (get total-amount channel-data)
            )
            ERR-INVALID-AMOUNT
        )
        (asserts! (>= dispute-nonce (get nonce channel-data)) ERR-INVALID-NONCE)
        ;; Update channel to disputed state
        (map-set channels { channel-id: channel-id }
            (merge channel-data {
                state: CHANNEL-DISPUTED,
                last-update: stacks-block-height,
            })
        )
        ;; Create dispute record
        (map-set channel-disputes { channel-id: channel-id } {
            initiator: tx-sender,
            dispute-block: stacks-block-height,
            proposed-balance-a: proposed-balance-a,
            proposed-balance-b: proposed-balance-b,
            dispute-nonce: dispute-nonce,
        })
        (print {
            event: "dispute-initiated",
            channel-id: channel-id,
            initiator: tx-sender,
            dispute-nonce: dispute-nonce,
        })
        (ok true)
    )
)

;; Public function: Resolve dispute (after timeout)
(define-public (resolve-dispute (channel-id uint))
    (let (
            (channel-data (unwrap! (map-get? channels { channel-id: channel-id })
                ERR-CHANNEL-NOT-FOUND
            ))
            (dispute-data (unwrap! (map-get? channel-disputes { channel-id: channel-id })
                ERR-CHANNEL-NOT-FOUND
            ))
        )
        ;; Validations
        (asserts! (is-eq (get state channel-data) CHANNEL-DISPUTED)
            ERR-DISPUTE-ACTIVE
        )
        (asserts!
            (>= stacks-block-height
                (+ (get dispute-block dispute-data) DISPUTE-TIMEOUT)
            )
            ERR-TIMEOUT-NOT-REACHED
        )
        ;; Settle with disputed balances
        (try! (as-contract (stx-transfer? (get proposed-balance-a dispute-data) tx-sender
            (get participant-a channel-data)
        )))
        (try! (as-contract (stx-transfer? (get proposed-balance-b dispute-data) tx-sender
            (get participant-b channel-data)
        )))
        ;; Update state
        (var-set total-locked
            (- (var-get total-locked) (get total-amount channel-data))
        )
        (map-set channels { channel-id: channel-id }
            (merge channel-data {
                state: CHANNEL-CLOSED,
                last-update: stacks-block-height,
            })
        )
        (print {
            event: "dispute-resolved",
            channel-id: channel-id,
        })
        (ok true)
    )
)

;; Public function: Close channel cooperatively
(define-public (close-channel (channel-id uint))
    (let ((channel-data (unwrap! (map-get? channels { channel-id: channel-id })
            ERR-CHANNEL-NOT-FOUND
        )))
        ;; Validations
        (asserts! (is-channel-participant channel-id tx-sender) ERR-UNAUTHORIZED)
        (asserts! (is-eq (get state channel-data) CHANNEL-OPEN)
            ERR-CHANNEL-CLOSED
        )
        ;; Transfer final balances
        (try! (as-contract (stx-transfer? (get balance-a channel-data) tx-sender
            (get participant-a channel-data)
        )))
        (try! (as-contract (stx-transfer? (get balance-b channel-data) tx-sender
            (get participant-b channel-data)
        )))
        ;; Update state
        (var-set total-locked
            (- (var-get total-locked) (get total-amount channel-data))
        )
        (map-set channels { channel-id: channel-id }
            (merge channel-data {
                state: CHANNEL-CLOSED,
                last-update: stacks-block-height,
            })
        )
        (print {
            event: "channel-closed",
            channel-id: channel-id,
        })
        (ok true)
    )
)

;; Public function: Emergency close (timeout-based)
(define-public (emergency-close (channel-id uint))
    (let ((channel-data (unwrap! (map-get? channels { channel-id: channel-id })
            ERR-CHANNEL-NOT-FOUND
        )))
        ;; Validations
        (asserts! (is-channel-participant channel-id tx-sender) ERR-UNAUTHORIZED)
        (asserts!
            (or
                (is-eq (get state channel-data) CHANNEL-OPEN)
                (is-eq (get state channel-data) CHANNEL-DISPUTED)
            )
            ERR-CHANNEL-CLOSED
        )
        (asserts! (>= stacks-block-height (get timeout-block channel-data))
            ERR-TIMEOUT-NOT-REACHED
        )
        ;; Emergency settlement with current balances
        (try! (as-contract (stx-transfer? (get balance-a channel-data) tx-sender
            (get participant-a channel-data)
        )))
        (try! (as-contract (stx-transfer? (get balance-b channel-data) tx-sender
            (get participant-b channel-data)
        )))
        ;; Update state
        (var-set total-locked
            (- (var-get total-locked) (get total-amount channel-data))
        )
        (map-set channels { channel-id: channel-id }
            (merge channel-data {
                state: CHANNEL-CLOSED,
                last-update: stacks-block-height,
            })
        )
        (print {
            event: "emergency-close",
            channel-id: channel-id,
        })
        (ok true)
    )
)

;; Read-only functions
(define-read-only (get-channel-details (channel-id uint))
    (map-get? channels { channel-id: channel-id })
)

(define-read-only (get-channel-dispute (channel-id uint))
    (map-get? channel-disputes { channel-id: channel-id })
)

(define-read-only (get-payment-commitment
        (channel-id uint)
        (nonce uint)
    )
    (map-get? payment-commitments {
        channel-id: channel-id,
        nonce: nonce,
    })
)

(define-read-only (get-user-channel-count (user principal))
    (default-to u0 (get channel-count (map-get? user-channels { user: user })))
)

(define-read-only (get-contract-stats)
    {
        total-channels: (var-get channel-counter),
        total-locked: (var-get total-locked),
        min-channel-amount: MIN-CHANNEL-AMOUNT,
        max-channel-amount: MAX-CHANNEL-AMOUNT,
        channel-timeout: CHANNEL-TIMEOUT,
        dispute-timeout: DISPUTE-TIMEOUT,
        settlement-fee: SETTLEMENT-FEE,
    }
)

(define-read-only (is-channel-active (channel-id uint))
    (match (map-get? channels { channel-id: channel-id })
        channel-data (is-eq (get state channel-data) CHANNEL-OPEN)
        false
    )
)

(define-read-only (get-contract-balance)
    (stx-get-balance (as-contract tx-sender))
)
