import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { THEME } from '../theme';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';

export const Scene10_ChainOfEvidence: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleSpring = spring({ frame, fps, config: { damping: 15 } });

  const evidenceCards = [
    { label: 'Event Timeline', detail: 'Ordered actions, deliveries, and state changes', tag: 'TRACE' },
    { label: 'State Snapshots', detail: 'Recorded state and accounting values', tag: 'STATE' },
    { label: 'Invariant Violation', detail: 'The failed check and recorded violation', tag: 'CHECK' },
    { label: 'Source Provenance', detail: 'Source identity, pinned brief, contract, and evaluator', tag: 'PROVENANCE' },
  ];

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: 1920,
        height: 1080,
        padding: '120px 120px 80px 120px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
      }}
    >
      {/* Header */}
      <div style={{ opacity: titleSpring, transform: `translateY(${interpolate(titleSpring, [0, 1], [20, 0])}px)` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
          <Badge label="STAGE 07 // FINDINGS & EVIDENCE" variant="cyan" />
          <Badge label="FULL AUDIT INTEGRITY" variant="green" />
        </div>
        <h2
          style={{
            fontFamily: THEME.fonts.sans,
            fontSize: 68,
            fontWeight: 800,
            letterSpacing: '-0.02em',
            color: THEME.colors.textMain,
            lineHeight: 1.1,
            margin: 0,
          }}
        >
          Keep the chain of evidence.
        </h2>
        <p
          style={{
            fontFamily: THEME.fonts.sans,
            fontSize: 32,
            color: THEME.colors.textMuted,
            marginTop: 14,
            maxWidth: 1300,
            lineHeight: 1.45,
          }}
        >
          Inspect the saved sequence, state, failed check, source identity, replay result, and clean comparison together.
        </p>
      </div>

      {/* 4 Evidence Pillars */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 20,
          margin: '20px 0',
        }}
      >
        {evidenceCards.map((ev, idx) => {
          const cardSpring = spring({
            frame: frame - (20 + idx * 25),
            fps,
            config: { damping: 14 },
          });
          const prog = frame >= 20 + idx * 25 ? cardSpring : 0;

          return (
            <div
              key={idx}
              style={{
                opacity: prog,
                transform: `translateY(${interpolate(prog, [0, 1], [25, 0])}px)`,
              }}
            >
              <Card
                variant="surface"
                borderColor="rgba(105, 199, 219, 0.3)"
                style={{
                  height: 210,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                }}
              >
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <Badge label={ev.tag} variant="dim" size="sm" />
                  </div>
                  <div style={{ fontFamily: THEME.fonts.sans, fontSize: 24, fontWeight: 700, color: THEME.colors.textMain }}>
                    {ev.label}
                  </div>
                </div>

                <div style={{ fontFamily: THEME.fonts.sans, fontSize: 17, color: THEME.colors.textMuted, lineHeight: 1.4 }}>
                  {ev.detail}
                </div>
              </Card>
            </div>
          );
        })}
      </div>

      {/* Footer Banner */}
      <Card
        variant="raised"
        style={{
          borderLeft: `4px solid ${THEME.colors.accentBright}`,
          padding: '16px 24px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span style={{ fontFamily: THEME.fonts.sans, fontSize: 22, color: THEME.colors.textMain }}>
          <strong style={{ color: THEME.colors.accentBright }}>Saved Artifacts:</strong> Reopen recorded evidence, rerun the pinned experiment, and generate a findings report.
        </span>
        <Badge label="INSPECT & REPLAY" variant="cyan" size="sm" />
      </Card>
    </div>
  );
};
