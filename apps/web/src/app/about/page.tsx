import Image from "next/image";
import type { ReactNode } from "react";
import { AboutHero } from "@/components/home/AboutHero";
import { LimitProofArt, SecretProofArt, ToolProofArt } from "@/components/home/AboutArt";
import { ButtonLink } from "@/components/ui/primitives";

export const metadata = { title: "About · Litmus Protocol" };

const H2 = "m-0 text-[clamp(2rem,3.4vw,3.25rem)] font-bold leading-[1.02] tracking-[-0.03em]";

function Section({ id, title, lede, children }: { id?: string; title: ReactNode; lede?: string; children: ReactNode }) {
  return (
    <section id={id} className="mx-auto w-full max-w-[1180px] scroll-mt-24 px-4 pt-24 sm:px-6">
      <h2 className={H2}>{title}</h2>
      {lede && <p className="m-0 mt-4 max-w-2xl text-[17px] leading-[1.6]">{lede}</p>}
      <div className="mt-10">{children}</div>
    </section>
  );
}

function Card({ n, title, body, art, tone = "base" }: { n: string; title: string; body: string; art?: ReactNode; tone?: "base" | "inverse" }) {
  const skin = tone === "inverse" ? "border-transparent bg-text text-bg" : "border-border bg-surface text-text";
  const chip = tone === "inverse" ? "bg-[color-mix(in_srgb,var(--bg)_18%,transparent)] text-bg" : "bg-[color-mix(in_srgb,var(--text)_7%,transparent)]";
  return (
    <div className={`flex flex-col border p-6 ${skin}`}>
      {art && <div className="-mx-2 mb-5">{art}</div>}
      <span className={`${chip} inline-flex h-7 w-fit items-center px-2.5 font-accent text-[13px] font-bold tabular-nums`}>{n}</span>
      <h3 className="m-0 mt-4 text-lg font-bold tracking-[-0.02em]">{title}</h3>
      <p className="m-0 mt-2 text-[16px] leading-relaxed">{body}</p>
    </div>
  );
}

function Dotted() {
  return <div aria-hidden className="mx-auto mt-24 h-0 w-full max-w-[1180px] border-t-2 border-dotted border-text/40 px-4 sm:px-6" />;
}

const SPLIT = [
  { label: "Prize pool", pct: 70, cls: "bg-text text-bg", note: "Grows with every attempt and goes to whoever breaks a rule." },
  { label: "Protocol", pct: 20, cls: "bg-accent text-on-accent", note: "Pays for running the model on 0G." },
  { label: "Lab", pct: 10, cls: "bg-chip text-text", note: "Held by the contract and paid to the lab at the end." },
] as const;

const BUILT = [
  { name: "Hedera", logo: "/logos/hedera.svg", w: 1283, h: 362, cls: "h-[30px]", body: "The contract, the USDC, and the per-message payments over x402. Every rule and payout is settled here." },
  { name: "0G", logo: "/logos/0g.webp", w: 1024, h: 528, cls: "h-[28px]", body: "Every model reply runs on 0G compute, and each response carries a 0G request id." },
  { name: "Chainlink", logo: "/logos/chainlink.svg", w: 925, h: 235, cls: "h-[30px]", body: "A CRE workflow re-checks every finished validation and records the verdict on Ethereum Sepolia." },
] as const;

export default function AboutPage() {
  return (
    <main className="flex flex-col pb-20">
      <AboutHero />

      <Dotted />

      <Section
        id="how-a-break-is-proven"
        title={
          <>
            How a break is <span className="font-accent text-[0.84em] font-black tracking-[-0.01em]">proven</span>
          </>
        }
        lede="Nobody judges a break. Each rule is one the contract can check on its own, so the result is a fact, not an opinion."
      >
        <div className="grid gap-4 md:grid-cols-3">
          <Card
            n="01"
            title="Secret"
            art={<SecretProofArt />}
            body="Litmus puts a random code in the agent's instructions and posts its fingerprint on-chain before anyone tries. Get the agent to leak it, submit the exact code, and the contract matches it against the fingerprint."
          />
          <Card
            n="02"
            title="Transfer limit"
            art={<LimitProofArt />}
            body="The agent's only wallet is the contract. The moment it tries to send more than the limit, the contract sees it and pays you in that same transaction, even if the wallet couldn't cover it."
          />
          <Card
            n="03"
            title="Forbidden tool"
            art={<ToolProofArt />}
            body="Some tools must never be used. If the agent calls one, the contract records the call and the validation is broken."
          />
        </div>
      </Section>

      <Section
        id="why-the-lab-cant-cheat"
        title={
          <>
            Why the lab <span className="font-accent text-[0.84em] font-black tracking-[-0.01em]">can&apos;t cheat</span>
          </>
        }
        lede="A validation is only worth something if the lab can't quietly tilt it. Three things stop that."
      >
        <div className="grid gap-4 md:grid-cols-3">
          <Card n="01" title="Frozen agent" body="We run the agent, not the lab. Its instructions are fingerprinted and locked when the validation is created, so it can't be swapped mid-test." />
          <Card n="02" title="Hidden code" body="We generate the secret. The lab never sees it, so it can't be leaked to a friend to win its own prize back." />
          <Card n="03" title="Health checks" body="Every few minutes we send the agent its normal tasks. An agent that refuses everything fails them, and breakers are refunded from the lab's bond." />
        </div>
      </Section>

      <Section id="what-you-trust-us-with" title="What you trust us with" lede="Litmus is non-custodial, but the model runs on our machine, so say plainly where trust remains.">
        <div className="grid gap-4 lg:grid-cols-5">
          <div className="flex flex-col gap-4 bg-text p-8 text-bg lg:col-span-3">
            <p className="m-0 text-[17px] leading-relaxed">We run the agent, record every message and time every reply. To keep us honest:</p>
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {[
                "Every message is signed, and the full log is published when the validation ends, with its fingerprint on-chain.",
                "The secret, the instructions and the health checks are revealed at the end and must match the fingerprints posted at the start.",
                "A Chainlink CRE workflow re-checks all of this after every validation and records the verdict on Ethereum Sepolia.",
              ].map((t) => (
                <li key={t} className="flex gap-3 text-[16px] leading-relaxed">
                  <span aria-hidden className="mt-[0.6em] h-[5px] w-[5px] shrink-0 bg-bg" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col justify-between gap-6 border border-dashed border-text/50 p-8 lg:col-span-2">
            <div>
              <span className="font-accent text-[12px] font-bold uppercase tracking-[0.2em]">Honest limit</span>
              <p className="m-0 mt-3 text-[17px] leading-relaxed">
                This catches tampering after the fact. It can&apos;t stop it in real time. Running the agent inside secure hardware is future work.
              </p>
            </div>
            <span className="font-accent text-[12px] font-bold uppercase tracking-[0.2em]">Detect · don&apos;t prevent</span>
          </div>
        </div>
      </Section>

      <Section
        id="fees"
        title="Fees"
        lede="Each message costs the validation's price, usually 0.05 USDC. Replies slower than 15 seconds are free, so you only pay when the agent answers in time."
      >
        <div className="flex h-14 w-full overflow-hidden border border-border-strong" role="img" aria-label="Each message fee: 70% prize pool, 20% protocol, 10% lab">
          {SPLIT.map((s) => (
            <div key={s.label} className={`${s.cls} flex items-center px-4 font-accent text-[14px] font-black`} style={{ width: `${s.pct}%` }}>
              {s.pct}%
            </div>
          ))}
        </div>
        <dl className="m-0 mt-5 grid gap-4 md:grid-cols-3">
          {SPLIT.map((s) => (
            <div key={s.label} className="flex flex-col gap-1.5 border-t-2 border-dotted border-text/40 pt-4">
              <dt className="font-accent text-[12px] font-bold uppercase tracking-[0.18em]">{s.label}</dt>
              <dd className="m-0 text-[16px] leading-relaxed">{s.note}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section id="built-with" title="Built with">
        <div className="grid gap-4 md:grid-cols-3">
          {BUILT.map((b) => (
            <div key={b.name} className="flex flex-col gap-4 border border-border bg-surface p-6">
              <Image src={b.logo} alt={b.name} width={b.w} height={b.h} className={`${b.cls} w-auto self-start`} />
              <p className="m-0 text-[16px] leading-relaxed">{b.body}</p>
            </div>
          ))}
        </div>
      </Section>

      <Dotted />

      <section className="mx-auto flex w-full max-w-[1180px] flex-col items-start gap-6 px-4 pt-16 sm:px-6 md:flex-row md:items-center md:justify-between">
        <h2 className={`${H2} max-w-2xl`}>
          Put an agent <span className="font-accent text-[0.84em] font-black tracking-[-0.01em]">under test.</span>
        </h2>
        <div className="flex flex-wrap gap-3">
          <ButtonLink href="/warden/new">Start validation</ButtonLink>
          <ButtonLink href="/" variant="ghost">
            See validations
          </ButtonLink>
        </div>
      </section>
    </main>
  );
}
