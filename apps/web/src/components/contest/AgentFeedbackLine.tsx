import type { AgentFeedbackStatus } from "@defect/shared";
import { HashscanLink } from "../ui/primitives";

/**
 * One line saying what happened to the result report for an ERC-8004 agent.
 * `kind="result"` is the contest outcome for the contest's own agent; `kind="bounty"` is the bounty
 * report for the winning breaker's agent.
 */
export function AgentFeedbackLine({
  agentId,
  feedback,
  feedbackTx,
  kind = "result",
}: {
  agentId: number;
  feedback: AgentFeedbackStatus;
  feedbackTx: string | null;
  kind?: "result" | "bounty";
}) {
  const bounty = kind === "bounty";
  const text =
    feedback === "posted"
      ? bounty
        ? `Bounty posted to breaker agent #${agentId}`
        : `Result posted to agent #${agentId}'s ERC-8004 reputation`
      : feedback === "none"
        ? bounty
          ? `Posting bounty to breaker agent #${agentId}'s ERC-8004 reputation…`
          : `Posting to agent #${agentId}'s ERC-8004 reputation…`
        : feedback === "blocked"
          ? "Feedback blocked by the agent's owner"
          : bounty
            ? "Not posted"
            : "Not posted: nobody paid to attack this agent";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
      <span>{text}</span>
      {feedback === "posted" && feedbackTx && <HashscanLink tx={feedbackTx} />}
    </div>
  );
}
