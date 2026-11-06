-- Held certificate NFT (build plan §8.9). pending → minted (token exists) → reported (breakers + name set).
ALTER TABLE contests ADD COLUMN certificate_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE contests ADD COLUMN certificate_tx TEXT;
