import { useState } from "react";
import type { Explanation, Preferences } from "../lib/contracts";

export function LearningPanel({ explanation, level, onLevel, onRequest, onQuestion, onOpenFile }: {
  explanation: Explanation | null;
  level: Preferences["level"];
  onLevel: (level: Preferences["level"]) => void;
  onRequest: (quiz: boolean) => void;
  onQuestion: (question: string) => void;
  onOpenFile: (path: string, line: number) => void;
}) {
  const [question, setQuestion] = useState("");
  const [answerVisible, setAnswerVisible] = useState(false);
  return (
    <section className="panel learning" aria-labelledby="learning-heading">
      <div className="section-title"><div><span className="eyebrow">Grounded learning</span><h2 id="learning-heading">Understand the change</h2></div><select value={level} onChange={(event) => onLevel(event.target.value as Preferences["level"])} aria-label="Explanation level"><option>beginner</option><option>intermediate</option><option>expert</option></select></div>
      {!explanation ? <div className="empty"><span>✦</span><p>Choose task evidence and ask for a bounded explanation.</p><button onClick={() => onRequest(false)}>Explain selected task</button></div> : <>
        <div className="model-line"><span className={`mode ${explanation.mode}`}>{explanation.mode}</span><span>{explanation.provider}</span>{explanation.mode === "offline" && <strong>Model offline</strong>}</div>
        <p className="explanation-summary">{explanation.summary}</p>
        {explanation.behaviorChanges.length > 0 && <div className="learning-group"><h3>Behavior changes</h3>{explanation.behaviorChanges.map((item) => <p key={item}>{item}</p>)}</div>}
        {explanation.concerns.length > 0 && <div className="learning-group concern"><h3>Concerns</h3>{explanation.concerns.map((item) => <p key={item}>{item}</p>)}</div>}
        <div className="citation-list">{explanation.evidence.map((ref) => ref.valid ? <button key={`${ref.path}-${ref.startLine}`} onClick={() => onOpenFile(ref.path, ref.startLine)}>{ref.path}<span>L{ref.startLine}–{ref.endLine}</span></button> : <div className="invalid-citation" key={ref.path}>⚠ Invalid citation hidden: {ref.path}</div>)}</div>
        {explanation.uncertainties.map((item) => <p className="uncertainty" key={item}>Uncertain: {item}</p>)}
        {explanation.quiz && <div className="quiz"><span className="eyebrow">Mini quiz</span><p>{explanation.quiz.question}</p><button className="secondary" onClick={() => setAnswerVisible((value) => !value)}>{answerVisible ? "Hide answer" : "Reveal answer"}</button>{answerVisible && <p className="quiz-answer">{explanation.quiz.answer}</p>}</div>}
        <div className="question-row"><input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask a follow-up…" /><button onClick={() => { if (question.trim()) onQuestion(question.trim()); setQuestion(""); }}>Ask</button></div>
        <button className="text-button" onClick={() => onRequest(true)}>Request a different quiz</button>
      </>}
    </section>
  );
}
