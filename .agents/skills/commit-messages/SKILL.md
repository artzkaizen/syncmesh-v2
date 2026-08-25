---
name: commit-messages
description: How syncmesh commits are written — a compulsory `type(scope):` prefix, then one plain-sentence subject under ~60 characters that says what changed and why it matters, then prose paragraphs with the problem, the cause, the decision, what was left out and how it was verified. Use before every `git commit`, including amend and reword.
---

# Commit messages

A commit message is read by someone doing `git log` or `git blame` months later, trying to
understand why the code is the way it is. It is prose for that reader. It is not a changelog,
a task list, or a summary of the diff — the diff is right there.

## Subject

One sentence, under ~72 characters, that says **what changed and why it matters**, in
plain language. Imperative or declarative, either is fine; no trailing period.

```
fix(compose): Warn instead of silently dropping an unparsable port
fix(swarm): Stop crash loops by scaling the service to zero
fix(web): Make the notification bell honest about its own state
fix(netbird): Generate the store key in the format it decodes
```

Every subject starts with a `type(scope):` prefix — it is not optional. The type is
one of `feat`, `fix`, `refactor`, `test`, `docs`, `style`, `build`, `chore`; the scope is
the package or area the diff lives in (`kernel`, `engine`, `wire`, `schema`, `temporal`,
`config`, `gen`, `plan`, `skills`, …). Drop the scope only when the change is genuinely
cross-cutting (`build:`, `docs:`). After the prefix, the same one sentence, and keep the
whole line short enough that a narrow log panel still shows the point — under ~60 is
the target, ~72 the ceiling:

```
feat(engine): Add undoDepth and revert, keeping the original partition
refactor(kernel): Route applyChange through mergeRecord: one join
test(wire): Garbage and mutated frames neither throw nor reach state
docs(plan): Write down three apps the API has to carry, and why
```

Not a subject:

```
E05: table() with definition-time refusals (0/2 primary keys, reserved or invalid names, …); t.json overloads; helper types without the Of suffix
```

That is an inventory joined with semicolons. Nobody can tell what the commit was *for*.
If a commit needs an inventory, it is several commits.

## Body

Paragraphs. Write for the reader who has the diff open and wants to know what they
cannot see in it:

- **The problem as observed.** What failed, what was wrong, what a test showed. Quote the
  actual error or the actual bytes when there is one.
- **The cause.** The real mechanism, named precisely (`compareStamp` returned 0 for
  distinct stamps; the formatter reflowed a JSON string across two lines).
- **The decision, and what was deliberately not done.** "Text stays out — it needs
  compaction first." "Opt-in per variable, deliberately: a guessed format is worse than
  none."
- **How it was verified**, concretely. Not "tests pass" — which test, against what.
- **References** last: a decision id (`D04`), an RFC (`RFC-0002`), an epic task, an issue.

Skip any of these that has nothing to say. A small commit may be one paragraph. A
mechanical one may be subject-only.

Not a body: a bulleted restatement of the files touched, or the sentence "this commit
adds X, Y and Z".

## Before committing

1. Does the subject carry a `type(scope):` prefix, and say why, not just what? Could a
   reader pick this commit out of fifty?
2. Is every claim in the body true of this diff — and verified, not hoped?
3. Would the paragraphs still make sense to someone who never saw this conversation?
