/**
 * Canned "recognized speech" for the mock backend. Written the way raw ASR
 * output typically looks: all lowercase, no punctuation, with filler words
 * like "um" / "uh" sprinkled in - which gives the cleanup pass something
 * real to do.
 */
export const DEMO_SCRIPTS: string[] = [
  `so um i think we should uh start the meeting by reviewing last quarter numbers ` +
    `revenue was up about twelve percent year over year and uh the churn rate ` +
    `actually went down which is great news for the team`,
  `okay uh let's talk about the roadmap for next sprint um we need to finish the ` +
    `onboarding flow first and then uh move on to the billing integration i think ` +
    `that should take about two weeks`,
  `um quick note to myself remember to follow up with sarah about the contract ` +
    `renewal and uh also book flights for the conference in october before the ` +
    `prices go up`,
  `alright so the plan is uh we ship the beta on friday um collect feedback over ` +
    `the weekend and then uh triage bugs on monday morning before the next release`,
  `hey um just wanted to say thanks to everyone who helped with the launch uh it ` +
    `was a huge effort and um i think we should celebrate as a team sometime next week`
]

export function pickRandomScript(): string[] {
  const script = DEMO_SCRIPTS[Math.floor(Math.random() * DEMO_SCRIPTS.length)]
  return script.split(/\s+/).filter(Boolean)
}

/** Extra filler-heavy words looped in if a session runs longer than the demo script. */
export const FILLER_LOOP_WORDS = [
  'um',
  'so',
  'yeah',
  'i',
  'guess',
  'uh',
  'that',
  'about',
  'covers',
  'it',
  'for',
  'now'
]
