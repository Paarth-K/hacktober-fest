// `lcc --setup`: a few numbered questions, saved to config.json.
import { spawn } from "node:child_process";
import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useState } from "react";
import { type Config, configPath, saveConfig } from "./config.js";

interface Q {
  key: keyof Config;
  title: string;
  hint?: string;
  options: { label: string; value: Config[keyof Config]; note?: string }[];
}

const FAST_GEMMA = "gemma4:e2b";

export function Setup({ initial, installedGemma }: { initial: Config; installedGemma: string[] }) {
  const { exit } = useApp();
  const gemmaOptions = [
    ...installedGemma.map((t) => ({ label: t, value: t, note: /31b|27b/.test(t) ? "best quality, slower" : "installed" })),
    ...(installedGemma.includes(FAST_GEMMA) ? [] : [{ label: FAST_GEMMA, value: FAST_GEMMA, note: "much faster, needs a one-time download" }]),
  ];
  const questions: Q[] = [
    { key: "level", title: "How much coding do you know?", hint: "Changes how Gemma asks questions and explains changes.", options: [
      { label: "New to coding", value: "beginner" }, { label: "Learning", value: "intermediate" }, { label: "Experienced", value: "expert" } ] },
    { key: "agent", title: "Which coding agent should make the changes?", options: [
      { label: "Claude Code", value: "claude" }, { label: "Codex", value: "codex", note: "needs `npx codex login`" } ] },
    { key: "claudeModel", title: "Which Claude model?", hint: "Haiku is the fastest.", options: [
      { label: "Haiku", value: "haiku", note: "fastest" }, { label: "Sonnet", value: "sonnet", note: "smarter, slower" }, { label: "Opus", value: "opus", note: "smartest, slowest" } ] },
    { key: "claudeThinking", title: "Let Claude think before acting?", options: [
      { label: "No", value: false, note: "faster" }, { label: "Yes", value: true, note: "better on hard tasks, slower" } ] },
    { key: "gemmaModel", title: "Which Gemma model should ask questions and explain?", options: gemmaOptions },
    { key: "showThinking", title: "How should Gemma think?", hint: "Either way you see Gemma's answer appear live as it writes.", options: [
      { label: "Answer directly", value: false, note: "fast (recommended)" }, { label: "Reason step by step first, and show the reasoning", value: true, note: "about 4x slower" } ] },
    { key: "autoPermissions", title: "Let Claude edit files and run commands without asking?", options: [
      { label: "Yes", value: true, note: "recommended" }, { label: "Only edit files", value: false } ] },
  ];
  const [step, setStep] = useState(0);
  const [cfg, setCfg] = useState<Config>(initial);
  const [pulling, setPulling] = useState<string | null>(null);
  const [pullLog, setPullLog] = useState("");
  const [confirmPull, setConfirmPull] = useState<string | null>(null);
  const done = step >= questions.length;

  useEffect(() => {
    if (done && !pulling && !confirmPull) {
      saveConfig(cfg);
      const t = setTimeout(() => exit(), 50);
      return () => clearTimeout(t);
    }
  }, [done, pulling, confirmPull]); // eslint-disable-line react-hooks/exhaustive-deps

  const pull = (tag: string) => {
    setPulling(tag);
    const child = spawn("ollama", ["pull", tag]);
    const onData = (d: Buffer) => setPullLog(d.toString().trim().split(/\r|\n/).filter(Boolean).at(-1) ?? "");
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) => {
      setPulling(null);
      setPullLog(code === 0 ? `Downloaded ${tag}.` : `Download failed (exit ${code}). You can run \`ollama pull ${tag}\` yourself later.`);
      if (code !== 0) setCfg((c) => ({ ...c, gemmaModel: installedGemma[0] ?? "" }));
      setStep((s) => s + 1);
    });
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") return exit();
    if (pulling) return;
    if (confirmPull) {
      if (input === "1") {
        const tag = confirmPull;
        setConfirmPull(null);
        return pull(tag);
      }
      if (input === "2") {
        setConfirmPull(null);
        setCfg((c) => ({ ...c, gemmaModel: installedGemma[0] ?? "" }));
        return setStep((s) => s + 1);
      }
      return;
    }
    if (done) return;
    const q = questions[step]!;
    if (key.return) return setStep((s) => s + 1); // keep current value
    const n = Number(input);
    const opt = q.options[n - 1];
    if (!opt) return;
    setCfg((c) => ({ ...c, [q.key]: opt.value }));
    if (q.key === "gemmaModel" && !installedGemma.includes(String(opt.value))) return setConfirmPull(String(opt.value));
    setStep((s) => s + 1);
  });

  return (
    <Box flexDirection="column" padding={1} gap={1}>
      <Text color="cyan" bold>◆ Companion setup</Text>
      {!done && !confirmPull && !pulling && (() => {
        const q = questions[step]!;
        return (
          <Box flexDirection="column">
            <Text dimColor>{`Question ${step + 1} of ${questions.length}`}</Text>
            <Text bold>{q.title}</Text>
            {q.hint && <Text dimColor>{q.hint}</Text>}
            <Box flexDirection="column" marginTop={1}>
              {q.options.map((o, i) => (
                <Text key={String(o.value)}>
                  <Text color="cyan" bold>{` ${i + 1} `}</Text> {o.label}
                  {o.note ? <Text dimColor>{`  ${o.note}`}</Text> : null}
                  {cfg[q.key] === o.value ? <Text color="green">{"  ← current"}</Text> : null}
                </Text>
              ))}
            </Box>
            <Text dimColor>Press a number · Enter keeps the current choice · Ctrl+C quits</Text>
          </Box>
        );
      })()}
      {confirmPull && (
        <Box flexDirection="column">
          <Text bold>{`${confirmPull} isn't downloaded yet. Download it now? (a few GB)`}</Text>
          <Text><Text color="cyan" bold> 1 </Text> Yes, download it</Text>
          <Text><Text color="cyan" bold> 2 </Text> No, keep the installed model</Text>
        </Box>
      )}
      {pulling && <Text>{`Downloading ${pulling}… ${pullLog}`}</Text>}
      {done && !pulling && (
        <Box flexDirection="column">
          {pullLog && <Text>{pullLog}</Text>}
          <Text color="green" bold>Saved. Run `lcc` in any project folder.</Text>
          <Text dimColor>{configPath()}</Text>
        </Box>
      )}
    </Box>
  );
}
