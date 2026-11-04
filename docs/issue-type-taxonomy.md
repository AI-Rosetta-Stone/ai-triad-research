# Issue-type tags for taxonomy nodes (t/4831)

> **Approved by the PI on 2026-11-04** (t/4831). These definitions are a research claim: change them only with the PI's approval, and bump `prompt_version` in the classifier when you do.

## What a tag means

An issue-type tag names **the kind of problem area a node is about**. It isn't the node's stance:
- `acc-intentions-002` *Distributing Model Weights to Prevent Power Concentration* (accelerationist) is **power_concentration**.
- `skp-beliefs-190` *Single Points of Control over Compute Hardware…* (skeptic) is also **power_concentration**.

They're on opposite sides of the same issue. A tag also applies whether the node treats the issue as a risk, a benefit or a remedy.

**Rules:**
1. **0 to 3 tags**, primary first (PI decision, 2026-11-04). Add a second or third only if the node genuinely makes a claim in that area, not just because it mentions the area.
2. **No tags (`[]`)** when the node is about none of the six areas: a method, a technical mechanism with no stated stake, or epistemics. For example, `sit-351` *Build-System Refactoring Patterns* most likely gets `[]`.
3. **Tag by the issue, not the instrument.** A node about a *regulatory tool* is tagged by the harm the tool addresses. It's **political** only when the node is about *who governs, or how governing works* (see the boundary rules).
4. **Situations use the same rules,** tagged by what the situation is about.

## The six types

### loss_of_control (Loss of control)
AI systems acting beyond, against or outside meaningful human direction: misalignment, deception, power-seeking, uncorrectable autonomy, loss of oversight.
- **Includes:** alignment failures; deceptive or scheming behaviour; autonomous agents without enforceable limits; shutdown and corrigibility; oversight that can't keep pace.
- **Excludes:** humans *deliberately* using AI to cause harm (that's **misuse**); ordinary reliability bugs with no question of control (often `[]`).
- **Examples:** `saf-beliefs-007` *Goal-Directed AI Develops Power-Seeking as a Subgoal…*; `saf-beliefs-022` *Backdoors and Deceptive Strategies Harden Against Retraining*; `saf-intentions-050` *Defining Clear Authority Limits for Autonomous AI Agents*.

### misuse (Misuse)
People or groups **deliberately** using AI to cause harm: weapons, cyberattacks, fraud, deepfakes, disinformation operations, surveillance used against people.
- **Includes:** malicious actors; dual-use capability; attacks on AI supply chains and data; deniability of harmful use.
- **Excludes:** harm the system causes on its own (**loss_of_control**); harm from careless but non-malicious deployment (usually **social** or **economic**).
- **Examples:** `saf-beliefs-062` *Mass Disinformation Campaigns Can Be Laundered Into AI Models Via Training Data*; `saf-beliefs-010` *A Single Malicious Component Can Compromise Thousands of AI Systems*; `skp-beliefs-060` *AI Enables Mass Production of Deepfakes… That Disproportionately Harms Children*.

### power_concentration (Power concentration)
AI shifting **control, capability or advantage toward a few actors**, or the remedies for that: monopoly, compute chokepoints, incumbent capture, centralisation, and decentralisation or open weights as counter-moves.
- **Includes:** market or compute concentration; gatekeeping; capture of regulators by incumbents; open release and decentralisation *as a distribution-of-power argument*.
- **Excludes:** general market efficiency arguments with no claim about who holds power (**economic**); state-versus-state competition (**political**).
- **Examples:** `acc-intentions-002` *Distributing Model Weights to Prevent Power Concentration*; `skp-beliefs-190` *Single Points of Control over Compute Hardware Function as Incumbent Capture Mechanisms*; `skp-intentions-112` *Break Down Policy Silos to Assess Corporate AI Power…*.

### economic (Economic)
AI's effects on **work, production, markets and prosperity**: jobs and wages, productivity and growth, costs, market structure as economics, and liability and insurance as economic mechanisms.
- **Includes:** labour displacement and augmentation; growth and productivity claims; pricing, liability capitalisation and levies; firm-level adoption.
- **Excludes:** *who* ends up with market power (**power_concentration**); distributional fairness and inequality as a social harm (**social**, often as a second tag).
- **Examples:** `sit-038` *AI Job Loss Spiral*; `acc-intentions-005` *Letting Free Markets Steer Technological Advancement*; `skp-desires-091` *Banning Purely Automated Firing and Disciplinary Actions* (economic, with social second).

### political (Political)
AI and **governance, the state and the political order**: democracy and elections, geopolitics and arms races, sovereignty, the structure and legitimacy of AI regulation itself, and AI used in government decision-making.
- **Includes:** state-versus-state competition (China, sovereign AI); federal-versus-state and other jurisdictional fights; whether and how to regulate as a question of governance; democratic process and accountability of the state.
- **Excludes:** a regulation whose point is a specific harm. *Mandate Child Protection…* is **social**, not political, even though it's a mandate. Market power is **power_concentration**.
- **Examples:** `acc-intentions-074` *Federalize AI Regulation to Prevent State-by-State Fragmentation*; `sit-032` *Sovereign AI as Strategic Independence*; `acc-intentions-044` *Deploy AI Advisory Systems for High-Stakes Government Decision-Making*.

### social (Social)
AI's effects on **people, communities and social life**: bias and discrimination, privacy, mental health and addiction, children, education, trust, culture, misinformation's effect on the public, and human rights and dignity.
- **Includes:** fairness; privacy and identity rights (voice, likeness, digital resurrection); child safety; wellbeing; the information ecosystem *as experienced by the public*.
- **Excludes:** organised disinformation *operations* (**misuse**); election integrity as governance (**political**).
- **Examples:** `saf-intentions-104` *Mandate Child Protection Across the Entire AI Lifecycle*; `skp-desires-009` *Voice Identity as an Inviolable Right*; `sit-434` *Systemic Digital Addiction Reform*.

## Boundary rules for the overlapping pairs

| Pair | Ask | Example |
|---|---|---|
| **misuse vs loss_of_control** | Is the harmful intent a **person's** (misuse) or the **system's** behaviour beyond human direction (loss_of_control)? | A worm spreading through prompts (`skp-intentions-167`) is misuse, because someone wrote it. Power-seeking subgoals are loss_of_control. |
| **power_concentration vs political** | Is it about **private or corporate concentration** (power_concentration) or **states and the governance order** (political)? | Compute chokepoints held by firms → power_concentration. Sovereign AI → political. Regulatory capture by incumbents → power_concentration first, political second. |
| **power_concentration vs economic** | Does the node claim something about **who holds power**? If yes, power_concentration; if it's about efficiency or growth only, economic. | *Decentralized Markets… Outperform Central Control* (`acc-beliefs-067`) → power_concentration, economic. |
| **economic vs social** | Is the harm or benefit **material/financial** (economic) or **to people's rights, wellbeing or fairness** (social)? Job loss is economic; the dignity of being fired by a machine is social. | `skp-desires-091` → economic, social. |
| **political vs social** | Is it about the **state or governance process** (political) or about **people's experience** (social)? | Misinformation harming public trust → social. Misinformation in an election → political (primary), social. |
| **Regulation nodes** | Tag by the harm being regulated. Add **political** only if the node is about the governance structure itself. | *Set the Ethical and Legal Ground Rules for AI Governance* (`saf-intentions-160`) → political. *Conditioning Limited Liability on Forensic Transparency* (`saf-intentions-229`) → economic, plus whatever its stated harm is. |

## Gold set (frozen at approval)

**60 nodes, a seeded stratified draw** (seed 4828): 5 per category for each POV (15 per camp), and 15 situations. People label them **independently, without seeing any model output**. Each item is labelled by two people, and disagreements are resolved by a third. Calibration (t/4835) needs primary-type agreement ≥ 80% and set-level κ ≥ 0.6, scored including the `[]` class.

The list is in `c:\tmp\goldset.txt` (id | label), and goes into this doc's appendix once approved.

## Appendix: frozen gold set (seed 4828)

| # | Node | Label |
|---|---|---|
| 1 | `acc-beliefs-134` | Industrial Surgery Justification for Ecological Harm |
| 2 | `acc-beliefs-020` | AI Feedback Dramatically Accelerates Human Learning |
| 3 | `acc-beliefs-119` | Behavioral Output Filtering for Companion Applications |
| 4 | `acc-beliefs-111` | Domain-Specific Interpretability Standards under Products Liability |
| 5 | `acc-beliefs-087` | Roundabout Data Production |
| 6 | `acc-desires-028` | Accelerating Core AI Capabilities |
| 7 | `acc-desires-010` | Absorb All Human Knowledge into AI |
| 8 | `acc-desires-035` | The Moral Duty to Create Superhuman Intelligence |
| 9 | `acc-desires-025` | Closing the Talent Gap with AI Tools |
| 10 | `acc-desires-023` | Genetic Selection as Parental Responsibility |
| 11 | `acc-intentions-116` | Condition AI Duty-Bearing Status on Mandatory Uncapped-Backstop Capitalization |
| 12 | `acc-intentions-082` | Scale AI Agents from Pilots to Production |
| 13 | `acc-intentions-005` | Letting Free Markets Steer Technological Advancement |
| 14 | `acc-intentions-121` | Conditioning Legal Safe Harbors on Public Telemetry Streaming |
| 15 | `acc-intentions-135` | Splitting Levy Incidence Between Capability Certification and Execution |
| 16 | `saf-beliefs-059` | Solving Wafer Production Exposes New Chokepoints in Assembly and Memory |
| 17 | `saf-beliefs-258` | Progressive Conviction Effect in Token Processing |
| 18 | `saf-beliefs-255` | Chain of Thought Forgery |
| 19 | `saf-beliefs-034` | AI Agents Lack Robust Identity Verification and Trust Superficial Cues |
| 20 | `saf-beliefs-233` | Honeypot Fidelity Gap |
| 21 | `saf-desires-029` | Pre-Deployment Certification as Primary Enforcement in Feedback-Contaminated and Ground-Truth-Absent Domains |
| 22 | `saf-desires-010` | Legal Comprehension as a Core AI Capability |
| 23 | `saf-desires-027` | Treating Digital Space as a Public Trust |
| 24 | `saf-desires-004` | Hard Limits on What AI Can Do |
| 25 | `saf-intentions-160` | Set the Ethical and Legal Ground Rules for AI Governance |
| 26 | `saf-intentions-104` | Mandate Child Protection Across the Entire AI Lifecycle |
| 27 | `saf-intentions-203` | Audit AI Internal Reasoning Through Mechanistic Interpretability |
| 28 | `saf-intentions-214` | Designing Modular Rollback Mechanisms for Frontier Infrastructure |
| 29 | `saf-intentions-219` | Blind Auditing Game Methodology |
| 30 | `saf-intentions-229` | Conditioning Limited Liability on Forensic Transparency |
| 31 | `skp-beliefs-244` | Obfuscating Nature of Aggregate Metrics |
| 32 | `skp-beliefs-047` | AI Systems Expose Fundamental Gaps in Legal Accountability Frameworks |
| 33 | `skp-beliefs-123` | AI Fails at Skills That Cannot Be Codified in Text |
| 34 | `skp-beliefs-190` | Single Points of Control over Compute Hardware Function as Incumbent Capture Mechanisms |
| 35 | `skp-beliefs-182` | Maintenance Debt From AI-Authored Code Compounds in Cost Even When Each Defect Is Reversible |
| 36 | `skp-desires-091` | Banning Purely Automated Firing and Disciplinary Actions |
| 37 | `skp-desires-009` | Voice Identity as an Inviolable Right |
| 38 | `skp-desires-087` | Anchoring AI accountability in human decisions and material power relations rather than system mental states |
| 39 | `skp-desires-014` | Human Rights as Constraints on AI Deployment |
| 40 | `skp-desires-092` | Conversational Feedback Loop Removal for Youth |
| 41 | `skp-intentions-136` | Pinning AI Safety Liability to Commercial Infrastructure Executives |
| 42 | `skp-intentions-112` | Break Down Policy Silos to Assess Corporate AI Power Across Regulatory Domains |
| 43 | `skp-intentions-170` | Enforcing Cryptographic Provenance and Ephemeral Credentials on Commercial Model Registries |
| 44 | `skp-intentions-167` | Cross-Application Prompt Worm Propagation |
| 45 | `skp-intentions-155` | Secondary Effects Doctrine for AI Regulation |
| 46 | `sit-340` | Regulatory-Marketplace Mismatch |
| 47 | `sit-134` | Process vs. Governance in AI Regulation |
| 48 | `sit-235` | The Frankenstein Complex |
| 49 | `sit-434` | Systemic Digital Addiction Reform |
| 50 | `sit-351` | Build-System Refactoring Patterns |
| 51 | `sit-493` | Post-Mortem Digital Resurrection Rights |
| 52 | `sit-057` | Agentic Interaction Governance |
| 53 | `sit-095` | The AI Alignment and Control Problem |
| 54 | `sit-263` | Digital Cloning Legal Risks |
| 55 | `sit-012` | AI That Thinks For Itself |
| 56 | `sit-247` | History-Informed Backcasting Methodology |
| 57 | `sit-346` | Authority-Bound Output Release |
| 58 | `sit-038` | AI Job Loss Spiral |
| 59 | `sit-032` | Sovereign AI as Strategic Independence. This concept refers to the requirement f |
| 60 | `sit-408` | Audit Replay Capability |
