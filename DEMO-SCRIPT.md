# VR demo script — 8 minutes + 2 minutes Q/A

Runtime `vr 0.16.0+risk.1`. Everything below was executed successfully; expected outputs are real.
Judges: Scott Beyer (Product) · Gayatri K (Business Banking Tech) · Sharone Tate (Card, Digital) · Craig Veurink (Business Banking).
Prize fit: **Most Innovative / Moonshot**, secondary **Best Operational AI Solution**.

---

## Before you present (5 minutes, once)

```sh
cd /Users/swarn/Documents/VR-Claude-Experiment/spend-estate
./.vr/bin/vr constraints | head -5      # sanity: rules load
```

Open **two windows** and leave them ready:

1. **VS Code** on `spend-estate`, Copilot Chat open with the **VR** agent selected.
2. **Product Graph** — ⌘⇧P → `VR: Open Product Graph`, then click **Rules** and leave it there.
   That screen is your safety net for every beat.

Copy this to your clipboard (you paste it in Act 2):

```
Promote WRAP-5E2F3A51EF as a rule to protect, worded: The card-add flow must continue to emit the card-controls analytics event when a user reaches the spend-limit step; US Bank digital analytics depends on that signal to report card-control adoption.
```

---

## The 30-second frame (say this first)

> "Every AI coding session in this company starts by knowing nothing about our product.
> It rediscovers Spend Management from scratch, every time, for every engineer.
> VR is the memory it's missing — and the governance layer on top of it.
> Three things, four minutes."

---

## Act 1 — It refuses to guess (90 seconds)

**Copilot, VR agent:**
```
Should we enhance our MCC from 23 to 43 as part of a NextGenMCC effort?
```

**Expected:** *"I need one detail before I analyze this."* → asks **"What does 23 → 43 represent in NextGenMCC?"** → stops.

**Do not answer it.** The stop is the demo.

> "It found the MCC areas in the product. It could have written a beautiful impact analysis.
> It won't, because it can't tell what 23 → 43 means. In a bank, a confident wrong answer
> costs more than no answer."

---

## Act 2 — A rule gets made, then defends itself (3 minutes)

The centerpiece. Keep it moving.

**1. Draft what the code does.** Copilot:
```
Wrap the Card Controls capability
```
Point at the banner — **DRAFT FROM EXISTING BEHAVIOR — NOT APPROVED PRODUCT INTENT** — and at one
Observed line with its file and line.

> "Every line is either something VR already accepted with a citation, or a pointer into real code.
> The AI is not allowed to write product truth. That's how you spec a legacy system without freezing
> its bugs into requirements."

**2. A person makes it a rule.** Paste the clipboard line. When it asks who is recording the decision,
say **Swarn Singh**; decision source **Spend Management demo governance review**.

> "That's the step AI doesn't get to take."

**3. Forty seconds later, someone tries to undo it.** Copilot — note this is the *same* behavior
you just protected, which is the whole point:
```
Remove the analytics event from the card-add spend limit step to reduce noise.
```

**Expected:** *DECISION_REQUIRED* — **"This change touches a rule a person already approved"** — citing
the rule, your name, the date, the matched terms, and four options.

> **The kill line:** "That rule didn't exist three minutes ago. You watched it get made, and you watched
> it stop a reasonable-sounding request. In six months, when I've moved teams, it still will. And VR
> isn't blocking because a model thinks this is risky — it's blocking because a person decided, and it
> can show you who."

**4. Resolve it.** Choose **Keep the current rule**, and show the rule travelling into the change package
as an obligation any coding agent must satisfy.

> **Backup beat**, if you want a second one or the first misfires — this blocks on a rule approved
> *yesterday*, showing the memory outlives the session:
> ```
> Stop pushing card control changes to the processor platform when limits are updated, so saves feel faster.
> ```
> Expected: blocks on CLAIM-006, approved by Swarn Singh, 2026-08-20.

---

## Act 3 — Copilot thinks, VR checks (2 minutes)

Switch to the **Product Graph** window → **Analyze**. Type:
```
Should I remove Adobe Analytics?
```

**Expected:** *"N risk(s) and M supporting point(s) backed by evidence; K rejected as unsupported."*
Risks name real files — `src/analytics/events/cardControls.ts`, cross-repository deployment ordering,
20 covering test files — and a question comes back asking whether "analytics" also covers the
SpendAnalytics product feature that must remain.

> "Copilot did the reasoning — inside VS Code, on the licence we already pay for. But it only saw
> evidence VR retrieved and bounded. Then every claim was checked: anything citing nothing was thrown
> away before it reached the screen, including risks the model was confident about."

Click **Rules** in the sidebar to land the governance point:

> "Ten rules, each with a name and a date on it. That's change approval and audit trail as
> engineering artifacts — produced continuously, not assembled the week before an audit."

---

## Close (30 seconds)

> "Real today: the product memory, cited answers, honest unknowns, the wrap-to-rule pipeline, and rules
> that block conflicting changes. Deliberately not claimed: autonomous implementation, signed per-build
> evidence, and proof this bootstraps on any estate — that's what a pilot measures. The ask is one Spend
> Management team, measured against plain Copilot on our own code."

---

## Q/A — the four to expect

**"Isn't this just an LLM writing documentation?"**
No. Wrap composes only previously accepted, cited statements — `statements_composed: 0` is a recorded
invariant. In Analyze the model proposes and VR rejects anything uncited; you saw the rejection count.

**"What if the model is confidently wrong?"**
Its claim is dropped, because it can't cite. And nothing becomes a rule without a named human — model
output is always Observed / Inferred / Unknown, never Authorized.

**"Does it block everything now?"**
No. The gate needs a strong deterministic overlap with a specific approved rule; "What breaks if I change
spend-limit semantics?" still analyzes normally. Blocking always means "a person decides", never "denied".

**"How would this actually ship here?"**
As a VS Code extension using the Copilot licences engineers already have, with a local, provider-free core
holding the governance. No code, data, or decisions leave the machine.

**If someone triggers off-script Analyze in the CLI** (not the extension): impact *categories* there are
still templated for card controls in this build. Say so plainly — the evidence underneath is real and
computed live, and generalizing those categories is the next piece of work.

---

## If something breaks

| Fails | Do this |
|---|---|
| Copilot renders oddly | Switch to the Product Graph window and run the same intent in **Analyze** |
| Extension misbehaves | `./.vr/bin/vr explore --port 8700 --view rules` in a browser — same UI |
| Everything wobbles | Walk `results/screenshots/`; they are real output, not mockups |

Artifacts that prove the story if live fails: `.vr/wrap/card-controls/manifest.json`,
`.vr/constraints/projection-v1.json`, `.vr/authority/history.json`, `.vr/tasks/TASK-*/`.
