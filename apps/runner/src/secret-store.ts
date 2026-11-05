import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/** invariantId → secret */
export type SecretMap = Record<string, string>;

interface StoreShape {
  drafts: Record<string, SecretMap>;
  contests: Record<string, SecretMap>;
}

/**
 * AES-256-GCM encrypted JSON file (build plan §9.2). Never log what this holds.
 * File format: JSON { v: 1, iv, tag, data } with base64 fields.
 */
export class SecretStore {
  private state: StoreShape;
  private readonly key: Buffer;

  constructor(
    private readonly file: string,
    hexKey: string,
  ) {
    this.key = Buffer.from(hexKey, "hex");
    if (this.key.length !== 32) throw new Error("Secret store key must be 32 bytes (64 hex characters)");
    this.state = existsSync(file) ? this.decrypt(readFileSync(file, "utf8")) : { drafts: {}, contests: {} };
  }

  getDraft(draftId: string): SecretMap | undefined {
    return this.state.drafts[draftId];
  }

  getContest(contestId: number): SecretMap | undefined {
    return this.state.contests[String(contestId)];
  }

  setDraft(draftId: string, secrets: SecretMap): void {
    this.state.drafts[draftId] = secrets;
    this.persist();
  }

  /** Moves a draft's secrets to the contest. Keeps existing contest secrets if already bound. */
  bindContest(contestId: number, secrets: SecretMap, draftId: string): void {
    this.state.contests[String(contestId)] = secrets;
    delete this.state.drafts[draftId];
    this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(this.state), "utf8"), cipher.final()]);
    const out = JSON.stringify({
      v: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, out, { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private decrypt(raw: string): StoreShape {
    try {
      const parsed = JSON.parse(raw) as { v: number; iv: string; tag: string; data: string };
      if (parsed.v !== 1) throw new Error(`unknown version ${parsed.v}`);
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(parsed.iv, "base64"));
      decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
      const plain = Buffer.concat([decipher.update(Buffer.from(parsed.data, "base64")), decipher.final()]);
      const state = JSON.parse(plain.toString("utf8")) as StoreShape;
      return { drafts: state.drafts ?? {}, contests: state.contests ?? {} };
    } catch (err) {
      throw new Error(
        `Cannot decrypt the runner secret store at ${this.file}: the file is corrupt or RUNNER_SECRETS_KEY changed (${(err as Error).message})`,
      );
    }
  }
}

/** For logs: never print a secret. */
export function redact(secret: string): string {
  return secret.length > 4 ? `${secret.slice(0, 4)}****` : "****";
}
