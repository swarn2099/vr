import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { learningCoverage } from "./coverage.js";
declare const acquireVsCodeApi: () => { postMessage(message: unknown): void };
const api = acquireVsCodeApi();
function App() {
  const [data, setData] = useState<any>(),
    [selected, setSelected] = useState<string>(),
    [answer, setAnswer] = useState(""),
    [reason, setReason] = useState(""),
    [error, setError] = useState(""),
    [history, setHistory] = useState<any[]>([]),
    [query, setQuery] = useState("");
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const m = event.data;
      if (m.type === "overview") setData(m.data);
      if (m.type === "history") setHistory(m.data);
      if (m.type === "error") setError(m.message);
    };
    window.addEventListener("message", receive);
    api.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", receive);
  }, []);
  const q = data?.questions.find((q: any) => q.id === selected);
  useEffect(() => {
    setAnswer("");
    setReason("");
    setHistory([]);
    if (selected) api.postMessage({ type: "history", id: selected });
  }, [selected, q?.revision]);
  const save = (action: string) => {
    setError("");
    api.postMessage({
      type: "review",
      input: {
        targetId: q.id,
        expectedRevision: q.revision,
        action,
        answer,
        reason,
        scope: { paths: q.paths },
      },
    });
  };
  return (
    <>
      <style>{`body{margin:0;color:var(--vscode-foreground,#dae7ec);background:var(--vscode-editor-background,#10202e);font:14px/1.55 system-ui}header{padding:26px 32px;border-bottom:1px solid #527076;background:linear-gradient(105deg,#123446,#125b5b);color:white}h1{margin:0;font-size:27px}main{padding:24px 32px;max-width:1200px;margin:auto}.muted{opacity:.72}nav{display:flex;gap:12px;flex-wrap:wrap}.stage{padding:12px 18px;border:1px solid #527076;border-radius:8px}section{display:grid;grid-template-columns:320px 1fr;gap:28px;margin-top:24px}button,input,textarea{font:inherit;color:inherit;background:var(--vscode-input-background,#1b3544);border:1px solid #527076;border-radius:5px;padding:9px}button{cursor:pointer}button:hover{border-color:#4dd9c7}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid #4dd9c7;outline-offset:2px}.question{display:block;text-align:left;width:100%;margin:10px 0}.selected{border-color:#4dd9c7}input,textarea{box-sizing:border-box;width:100%}textarea{min-height:100px}label{display:block;margin:16px 0 6px}article{min-width:0}code{overflow-wrap:anywhere}pre{white-space:pre-wrap;font-size:12px}footer{display:flex;gap:10px;flex-wrap:wrap;margin-top:15px}.error{color:#ffad95}.pill{font-size:11px;text-transform:uppercase;color:#68dccf}.history{border-top:1px solid #527076;padding-top:12px;margin-top:16px}@media(max-width:800px){section{grid-template-columns:1fr}main{padding:16px}}`}</style>
      <header>
        <h1>VR · Product knowledge</h1>
        <div>Understand the rule. See its evidence. Keep the history.</div>
      </header>
      <main>
        {!data ? (
          <p>Loading your estate…</p>
        ) : (
          <>
            <h2>{data.product.name}</h2>
            {data.onboarding && (
              <div role="status" aria-live="polite">
                <b>{data.onboarding.phase}</b>
                <p>{data.onboarding.message}</p>
                {data.onboarding.optionalFailures?.map((f: any) => (
                  <p className="error" key={f.stage}>
                    {f.stage}: {f.error}
                  </p>
                ))}
              </div>
            )}
            <p>
              {data.sources.filter((s: any) => s.kind === "git").length}{" "}
              repositories · One shared product
            </p>
            <p className="muted">
              {learningCoverage(data)
                .stages.map(
                  (s: any) =>
                    `${s.stage}: ${s.state}${s.collection ? ` (source ${s.collection.state})` : ""}`,
                )
                .join(" · ")}
            </p>
            <nav>
              {learningCoverage(data).jobs.map((j: any) => (
                <div className="stage" key={j.id}>
                  <b>{j.stage}</b>
                  <div>{j.repository}</div>
                  <div>
                    {j.processed} / {j.total} processed · {j.reused} reused
                  </div>
                  <span className="pill">{j.state}</span>
                </div>
              ))}
            </nav>
            <p className="muted">
              Focused investigations:{" "}
              {learningCoverage(data).investigations.completed} /{" "}
              {learningCoverage(data).investigations.total} finished ·{" "}
              {learningCoverage(data).investigations.budgetExhausted} reached
              their call budget.
            </p>
            <p className="muted">
              Unanswered questions can remain after processing finishes;
              interrupted or unprocessed work remains incomplete.
            </p>
            <section>
              <aside>
                <h2>Questions ({data.questions.length})</h2>
                <input
                  aria-label="Search questions"
                  placeholder="Find a rule, file or question"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {data.questions
                  .filter((q: any) =>
                    JSON.stringify(q)
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  )
                  .map((q: any) => (
                    <button
                      className={
                        "question " + (selected === q.id ? "selected" : "")
                      }
                      key={q.id}
                      onClick={() => setSelected(q.id)}
                    >
                      <span className="pill">
                        {q.state} · revision {q.revision}
                      </span>
                      <br />
                      {q.question}
                    </button>
                  ))}
              </aside>
              <article>
                {!q ? (
                  <p>
                    Select a question to inspect its evidence and recorded
                    answers.
                  </p>
                ) : (
                  <>
                    <h2>{q.question}</h2>
                    <p>{q.reason}</p>
                    <p className="muted">
                      Scope:{" "}
                      <code>
                        {q.paths.join(", ") || "Scope needs clarification"}
                      </code>
                    </p>
                    <button
                      onClick={() =>
                        api.postMessage({ type: "evidence", ids: q.evidence })
                      }
                    >
                      Read exact evidence
                    </button>
                    <label htmlFor="answer">Your clarification</label>
                    <textarea
                      id="answer"
                      value={answer}
                      onChange={(e) => setAnswer(e.target.value)}
                      placeholder="Explain the intended behavior and any exceptions."
                    />
                    <label htmlFor="reason">
                      Reason or supporting evidence
                    </label>
                    <textarea
                      id="reason"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                    <p className="muted">
                      Your identity and UTC timestamp are recorded with each
                      revision. A clarification does not automatically verify
                      implementation.
                    </p>
                    <footer>
                      <button
                        disabled={!answer.trim() || !reason.trim()}
                        onClick={() => save("clarify")}
                      >
                        Save clarification
                      </button>
                      <button
                        onClick={() =>
                          api.postMessage({ type: "investigate", id: q.id })
                        }
                      >
                        Queue focused investigation
                      </button>
                      <button
                        disabled={!reason.trim()}
                        onClick={() => save("defer")}
                      >
                        Defer
                      </button>
                      <button
                        disabled={!reason.trim()}
                        onClick={() => save("reopen")}
                      >
                        Reopen
                      </button>
                    </footer>
                    <p className="muted">
                      Queued investigations run when you next start or resume
                      learning with your chosen model.
                    </p>
                    <div className="history">
                      <h3>Revision history</h3>
                      {history.length ? (
                        history.map((r) => (
                          <div key={r.id}>
                            <b>
                              Revision {r.revision} · {r.actor.name}
                            </b>
                            <div>
                              {new Date(r.created_at).toLocaleString()} ·{" "}
                              {r.action} · {r.actor.identityBasis}
                            </div>
                            <p>{r.new_value.answer ?? r.new_value.state}</p>
                            <p className="muted">{r.reason}</p>
                          </div>
                        ))
                      ) : (
                        <p>No human revisions yet.</p>
                      )}
                    </div>
                  </>
                )}
              </article>
            </section>
          </>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </main>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
