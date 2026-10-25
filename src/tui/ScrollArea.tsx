import { Box, Text, useBoxMetrics, type DOMElement } from "ink";
import { useEffect, useRef, type ReactNode } from "react";

/** Fixed-height viewport; content scrolls by `scroll` rows. Reports content height so the parent can clamp. */
export function ScrollArea({ height, scroll, onContentHeight, children }: { height: number; scroll: number; onContentHeight: (h: number) => void; children: ReactNode }) {
  const ref = useRef<DOMElement>(null);
  const { height: contentHeight, hasMeasured } = useBoxMetrics(ref);
  useEffect(() => {
    if (hasMeasured) onContentHeight(contentHeight);
  }, [contentHeight, hasMeasured]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Box height={height} overflow="hidden" flexDirection="column" flexShrink={0}>
      <Box ref={ref} flexDirection="column" marginTop={-scroll} flexShrink={0}>
        {children}
      </Box>
    </Box>
  );
}

export function ScrollHint({ above, below }: { above: boolean; below: boolean }) {
  if (!above && !below) return <Text> </Text>;
  return <Text dimColor>{`${above ? "▲ PgUp " : ""}${below ? "▼ more below · PgDn" : ""}`}</Text>;
}
