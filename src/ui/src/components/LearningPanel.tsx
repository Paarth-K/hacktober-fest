import { useState } from "react";
import type { ExplanationResponse, ModelStatus, Preferences } from "../../../shared/index.js";
import { modelStatusLabel } from "../lib/state.js";

export function LearningPanel({ explanation, modelStatus, level, onLevel, onRequest, onQuestion, onOpenFile }: {
  explanation: ExplanationResponse | null;
  modelStatus: ModelStatus;
  level: Preferences["level"];
  onLevel: (level: Preferences["level"]) => void;
  onRequest: (quiz: boolean) => void;
  onQuestion: (question: string) => void;
  onOpenFile: (path: string, line: number) => void;
}) {
  const [question, setQuestion] = useState("");
  const [visibleAnswers, setVisibleAnswers] = useState<Set<number>>(new Set());

  const toggleAnswer = (index: number) => {
    setVisibleAnswers((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <section className="panel learning" aria-labelledby="learning-heading">
      <div className="section-title">
        <div><span className="eyebrow">Grounded learning</span><h2 id="learning-heading">Understand the change</h2></div>
        <select value={level} onChange={(event) => onLevel(event.target.value as Preferences["level"])} aria-label="Explanation level">
          <option>beginner</option><option>intermediate</option><option>expert</option>
        </select>
      </div>
      {!explanation ? (
        <div className="empty">
          <span>✦</span>
          <p>{modelStatusLabel(modelStatus)}. Choose task evidence and ask for a bounded explanation.</p>
          <button onClick={() => onRequest(false)} disabled={modelStatus.state === "offline"}>Explain selected task</button>
        </div>
      ) : (
        <>
          <div className="model-line"><span className={`mode ${explanation.mode}`}>{explanation.mode}</span><span>{explanation.provider}{explanation.model ? ` · ${explanation.model}` : ""}</span>{modelStatus.state === "offline" && <strong>Model offline</strong>}</div>
          <p className="explanation-summary">{explanation.summary}</p>
          {explanation.behaviorChanges.length > 0 && <div className="learning-group"><h3>Behavior changes</h3>{explanation.behaviorChanges.map((item) => <p key={item}>{item}</p>)}</div>}
          {explanation.concepts.length > 0 && <div className="learning-group"><h3>Concepts</h3>{explanation.concepts.map((concept) => <p key={concept.name}><strong>{concept.name}:</strong> {concept.explanation}</p>)}</div>}
          {explanation.concerns.length > 0 && <div className="learning-group concern"><h3>Concerns</h3>{explanation.concerns.map((item) => <p key={item}>{item}</p>)}</div>}
          <div className="citation-list">{explanation.evidence.map((ref) => <button key={`${ref.path}-${ref.startLine}`} onClick={() => onOpenFile(ref.path, ref.startLine)}>{ref.path}<span>L{ref.startLine}–{ref.endLine}</span></button>)}</div>
          {explanation.invalidCitations.map((ref) => <div className="invalid-citation" key={`${ref.path}-${ref.startLine}`}>⚠ Invalid citation hidden: {ref.path}</div>)}
          {explanation.uncertainties.map((item) => <p className="uncertainty" key={item}>Uncertain: {item}</p>)}
          {explanation.quiz?.map((quiz, index) => <div className="quiz" key={`${quiz.question}-${index}`}><span className="eyebrow">Mini quiz</span><p>{quiz.question}</p>{quiz.choices?.map((choice) => <small key={choice}>○ {choice}</small>)}<button className="secondary" onClick={() => toggleAnswer(index)}>{visibleAnswers.has(index) ? "Hide answer" : "Reveal answer"}</button>{visibleAnswers.has(index) && <p className="quiz-answer">{quiz.answer}{quiz.explanation ? ` — ${quiz.explanation}` : ""}</p>}</div>)}
          <div className="question-row"><input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask a follow-up…" /><button onClick={() => { if (question.trim()) onQuestion(question.trim()); setQuestion(""); }}>Ask</button></div>
          <button className="text-button" onClick={() => onRequest(true)}>Request a different quiz</button>
        </>
      )}
    </section>
  );
}
