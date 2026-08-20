Agent module :
What this is

The agent is a module. The product is everything around it
Anyone can demo a voice agent. What a clinical organisation cannot do is put one in front of a patient and defend it afterwards — which is what this is for. A protocol composed as data, a harness that proves the agent honours it, a deployment trail, and a named clinician's signature on whatever comes back. All of it driven from these dashboards.

01 · COMPOSE
Declare the call
What the agent may ask, what counts as an issue, what it must never say, and the shape of the output it has to return. A protocol is data, not code — versioned, signed off by a named role, and immutable once published. Nothing clinical is written in a prompt by an engineer.
protocol composer · versions · sign-off
02 · PROVE
Benchmarks and evals
Two harnesses answering two different questions. The benchmark measures the voice pipeline — time to first word, turn latency, the cost of every hop. The evals measure conformance: did it ask everything the protocol declared, ask nothing it did not, catch every phrase in the escalation set, and return a valid output. A version that fails its evals cannot be deployed.
bench · conformance suite · per-protocol suite
03 · RUN
Deploy, watch, sign
Send a published version to a patient, watch what comes back land in exactly one of three states, and sign it. Every interview pins the protocol version it ran under and the eval report that version passed — so “why did it ask that?” is still answerable months later.
deployments · review queue · signature
Anyone can demo an agent. The product is the evidence that it did what it was told.

Start with admin calls, and climb only as far as the evidence takes you
Call types are not equally hard, and what separates them is not engineering. It is how much clinical input the protocol needs before anyone can put their name to it — which is a fact about the document, not about the system underneath it. So the platform starts at the bottom of that ladder, where an agent is genuinely useful with no clinical content whatsoever, and the same harness carries you up.

Call type	Clinical input	Signed off by	What the agent may say	Output
Admin — confirm, remind, reschedule	none	Operations	Logistics only. It never asks how anybody feels.	An attendance decision
Research — structured instrument	low	Study lead	The instrument's fixed wording, unaltered.	Instrument scores
Pre-operative assessment	high	Pre-op lead · anaesthetist	Only the declared items — facts a patient already knows about themselves.	A typed assessment
Post-operative check	high	Surgical team	Declared items, with a symptom-led escalation set.	A typed check and a disposition
The first row is the one to build first, and it is not a toy. An appointment confirmation call that reaches everyone, records who is coming, and hands a human anything odd pays for itself — and it exercises every part of the platform the clinical calls depend on: deployment, windows, verification, escalation, review, signature. The distance from row one to row four is a protocol document and a sign-off, not a rebuild.

Which is also the safety argument. If the clinical content lives in a versioned document that a named clinician signs, then the thing engineering is accountable for is narrow and testable: did the agent do exactly what the document said, and nothing else. That is the question the evals ask, and it is the only question the dashboards below let anyone answer with a signature.