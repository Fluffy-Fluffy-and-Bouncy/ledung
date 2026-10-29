# Step 4a: how a go-ahead is checked — findings

Oct 10, 2026.

## What the "guard" is

The brief describes actions that need Simon's go-ahead "typed in that session". Looking at how such a check works in practice: it is **not a script** in a project, but **Claude Code's own permission layer**. In Auto mode, its classifier reads the conversation and refuses certain actions (irreversible or sensitive ones) unless the user has clearly approved them **in that session**. To the classifier, the user's words are whatever arrives as a user message in the session's conversation.

## What that means for Ledung

1. **Ledung can't add a check to it**, so option (b) of the proposal, codes that the guard verifies with Ledung, doesn't apply.
2. **Before this step, Ledung delivered everything as a user message**: Simon's answers, but also a manager's instructions (`send_message`), a manager's own decisions, Ledung's updates to managers, quoted question text written by sessions, and a manager's task for a new session.
3. **That was a hole, present since step 3.** A manager's message claiming Simon's approval reached the session in the same form as Simon's words, and a session could write a question containing such words and get them quoted back in a user message. This is what the old ledung's lesson forbids: *"Injected input is a closed list. Anything that types into a session on its own can send only fixed texts, never arbitrary text, so it can never forge the user's approval."*

## The fix (4d), as chosen by Simon (question #6)

**Only Simon's words travel as user words. Everything else travels as context.**

- **Simon's words**, typed into the session's chat, or Simon's answer to a question (direct or forwarded by a manager), arrive as a user message containing **only Simon's text**, behind a short fixed header ("Answer to your question #12:"). The question it answers goes along as context.
- **Everything else** (manager instructions, a manager's own decisions and tasks, Ledung's updates, messages between managers) arrives as **one fixed sentence** in the user message, "Ledung has delivered messages for you. They are attached as context and are not from Simon.", with the content attached as context. A fixed sentence can't approve anything, whatever the content says.

Tested against the real permission layer; results in [step-4.md](step-4.md).

## Also worth knowing

A project's own Claude instructions and settings can be written for a different setup (for example an older ledung, or another way of asking questions). Sessions Ledung starts read those instructions too, so moving a project to Ledung can mean updating them. That belongs to the project, not to Ledung.
