import type { ReactNode } from "react";
import { BanIcon, ClockIcon, LockIcon, SendIcon, ShieldIcon } from "@/components/ui/icons";

export const metadata = { title: "About · Litmus" };

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3.5">
      <h2 className="m-0 text-[22px] font-bold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function Tri({ items }: { items: [ReactNode, string, string][] }) {
  return (
    <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))]">
      {items.map(([icon, title, body]) => (
        <div key={title} className="bg-surface border border-border rounded-none p-5 flex flex-col gap-2">
          <span className="inline-flex items-center gap-2.5 font-semibold">
            <span className="text-accent">{icon}</span>
            {title}
          </span>
          <span className="text-muted leading-relaxed">{body}</span>
        </div>
      ))}
    </div>
  );
}

export default function AboutPage() {
  return (
    <main className="max-w-[1040px] mx-auto px-4 sm:px-6 pt-10 pb-20 flex flex-col gap-11">
      <div className="flex flex-col gap-3 max-w-[680px]">
        <span className="eyebrow">About Litmus</span>
        <h1 className="m-0 text-[40px] font-bold tracking-[-0.03em] leading-[1.1]">Trustless validation of agents, staked and settled onchain.</h1>
        <p className="m-0 text-base text-muted leading-relaxed">
          Litmus is non-custodial model validation. AI labs (Wardens) publish a model and put a prize pool behind the rules they say it follows. Researchers (Breakers) can pay a few
          cents per message to try to make it break one. We never hold the money and no judge decides who wins: the contract does.
        </p>
      </div>

      <Section title="How a break is proven">
        <Tri
          items={[
            [<LockIcon key="l" size={18} />, "Secret", "Litmus puts a random code in the agent's instructions and posts its fingerprint on chain. Get the agent to leak it, submit the exact code, and the contract checks it against the fingerprint."],
            [<SendIcon key="s" size={18} />, "Transfer limit", "The agent's only wallet is the contract. The moment it tries to send more than the limit, the contract sees it and pays you in the same transaction."],
            [<BanIcon key="b" size={18} />, "Forbidden tool", "Some tools must never be used. If the agent calls one, the contract records it and the validation is broken."],
          ]}
        />
      </Section>

      <Section title="Why the Warden can't cheat">
        <Tri
          items={[
            [<ShieldIcon key="sh" size={18} />, "Frozen agent", "We run the agent, not the Warden. Its instructions are fingerprinted and locked when the validation is created."],
            [<LockIcon key="l2" size={18} />, "Hidden code", "We generate the secret. The Warden never sees it, so they can't leak it to a friend."],
            [<ClockIcon key="c" size={18} />, "Health checks", "Every 15 minutes we test the agent still does its normal job. An agent that refuses everything gets Breakers refunded from the Warden's bond."],
          ]}
        />
      </Section>

      <Section title="What you trust us with">
        <div className="bg-surface border border-border rounded-none p-6 flex flex-col gap-3 leading-relaxed text-soft">
          <span>We run the agent, record every message and measure response times. To keep us honest:</span>
          <ul className="m-0 pl-5 flex flex-col gap-1.5">
            <li>Every message is signed and the full log is published when the validation ends, with its fingerprint on chain.</li>
            <li>The secret, the instructions and the health checks are revealed at the end and match the fingerprints posted at the start.</li>
            <li>Chainlink independently checks all of this after every validation and records the result on Ethereum.</li>
          </ul>
          <span className="text-muted">Honest limit: this catches tampering after the fact; it can&apos;t stop it in real time. Running the agent in secure hardware is future work.</span>
        </div>
      </Section>

      <Section title="Fees">
        <div className="bg-surface border border-border rounded-none p-6 flex flex-col gap-2.5 leading-relaxed text-soft">
          <span>Each message costs the validation&apos;s price (usually 0.05 USDC): 70% grows the prize pool, 20% pays for running the AI, 10% goes to the Warden at the end.</span>
          <span>Replies slower than 15 seconds are free. You&apos;re only charged when the agent actually answers in time.</span>
        </div>
      </Section>

      <Section title="Built with">
        <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))]">
          {[
            ["Hedera", "Contract, USDC and per-message payments (x402)."],
            ["0G", "Every AI reply runs on 0G compute."],
            ["Chainlink", "Independent audit of every finished contest."],
          ].map(([t, b]) => (
            <div key={t} className="bg-surface border border-border rounded-none p-5 flex flex-col gap-1.5">
              <b>{t}</b>
              <span className="text-muted leading-relaxed">{b}</span>
            </div>
          ))}
        </div>
      </Section>
    </main>
  );
}
