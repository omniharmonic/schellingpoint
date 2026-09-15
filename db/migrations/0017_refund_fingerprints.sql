-- Replay protection needs only equality, not a recoverable Stripe payment ID.
-- Keep an irreversible fingerprint so archived tickets cannot be re-identified
-- through this private ledger after their payment references are removed.
ALTER TABLE public.refunded_payments RENAME COLUMN payment_intent_id TO payment_fingerprint;
UPDATE public.refunded_payments
  SET payment_fingerprint = encode(extensions.digest(payment_fingerprint, 'sha256'), 'hex');
ALTER TABLE public.refunded_payments ADD CONSTRAINT refund_fingerprint_shape
  CHECK (payment_fingerprint ~ '^[0-9a-f]{64}$');
