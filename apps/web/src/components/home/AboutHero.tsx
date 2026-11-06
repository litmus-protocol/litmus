"use client";

import { DitherTest } from "./DitherTest";

/** About-page hero: the pitch on the left, the open test animation on the right. */
export function AboutHero() {
  return (
    <section className="mx-auto grid w-full max-w-[1180px] items-center gap-10 px-4 pt-14 sm:px-6 lg:grid-cols-12 lg:gap-14">
      <div className="flex flex-col gap-5 lg:col-span-7">
        <span className="eyebrow">About Litmus Protocol</span>
        <h1 className="m-0 text-[clamp(2.4rem,4.4vw,4.25rem)] font-bold leading-[1] tracking-[-0.03em]">
          Trustless validation of <span className="font-accent text-[0.86em] font-black tracking-[-0.01em]">agents.</span>
        </h1>
        <p className="m-0 max-w-2xl text-[clamp(1.05rem,1.2vw,1.25rem)] leading-[1.6]">
          Everyone can read the code, but a lab saying its model is safe is still a sentence you have to trust. Litmus turns it into a test anyone can run.
        </p>
        <p className="m-0 max-w-2xl text-[17px] leading-[1.65]">
          A lab (a <strong className="font-bold">Warden</strong>) publishes a model and puts a prize pool behind what it says it will never do. Researchers (<strong className="font-bold">Breakers</strong>) pay a few
          cents a message to try to make it break a rule. We never hold the money and no judge decides who wins: the contract does.
        </p>
      </div>
      <div className="lg:col-span-5">
        <DitherTest />
      </div>
    </section>
  );
}
