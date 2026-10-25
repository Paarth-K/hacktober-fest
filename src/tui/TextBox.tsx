import { Box, Text } from "ink";

/** Single input line. Keystrokes are routed by App (one useInput for the whole UI). */
export function TextBox({ value, placeholder, active, label }: { value: string; placeholder: string; active: boolean; label?: string }) {
  return (
    <Box borderStyle="round" borderColor={active ? "cyan" : "gray"} paddingX={1} flexDirection="column">
      {label && <Text color="cyan" bold>{label}</Text>}
      <Box>
        <Text color={active ? "cyan" : "gray"}>› </Text>
        {value ? (
          <>
            <Text wrap="wrap">{value}</Text>
            {active && <Text color="cyan">▏</Text>}
          </>
        ) : (
          <>
            {active && <Text color="cyan">▏</Text>}
            <Text dimColor>{placeholder}</Text>
          </>
        )}
      </Box>
    </Box>
  );
}
