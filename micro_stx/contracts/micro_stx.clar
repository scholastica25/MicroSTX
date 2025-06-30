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
