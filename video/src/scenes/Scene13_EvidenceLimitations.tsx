import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { THEME } from '../theme';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';

export const Scene13_EvidenceLimitations: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleSpring = spring({ frame, fps, config: { damping: 15 } });

  const boundaries = [
    {
      title: 'Scripted Mock Provider',
      fact: 'Mock mode runs fixed local scripts for testing UI & pipelines. It is not autonomous AI discovery.',
      color: THEME.colors.accentAmber,
      badge: 'DETERMINISTIC SCRIPT',
    },
    {
      title: 'Prose vs Executable Rules',
      fact: 'Prose provides context. Executable evaluators are required to check behaviour.',
      color: THEME.colors.accentCyan,
      badge: 'VERIFIED INVARIANTS',
    },
    {
      title: 'Bounded Synthetic Results',
      fact: 'Passing checks is evidence about specific synthetic scenarios. It does not prove production correctness.',
      color: THEME.colors.accentRed,
      badge: 'SCENARIO-BOUNDED',
    },
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
          <Badge label="SCIENTIFIC INTEGRITY" variant="amber" />
          <Badge label="CLEAR EVIDENCE BOUNDARIES" variant="dim" />
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
          Be precise about the evidence.
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
          Distinguish scripted demonstrations, executable checks, and verified findings. Keep the limits visible.
        </p>
      </div>

      {/* 3 Explicit Evidence Boundary Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 24,
          margin: '20px 0',
        }}
      >
        {boundaries.map((bnd, idx) => {
          const cardSpring = spring({
            frame: frame - (20 + idx * 30),
            fps,
            config: { damping: 14 },
          });
          const prog = frame >= 20 + idx * 30 ? cardSpring : 0;

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
                borderColor={bnd.color}
                style={{
                  borderTop: `4px solid ${bnd.color}`,
                  height: 220,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                }}
              >
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                    <Badge label={bnd.badge} variant="dim" size="sm" />
                  </div>
                  <div style={{ fontFamily: THEME.fonts.sans, fontSize: 24, fontWeight: 750, color: THEME.colors.textMain }}>
                    {bnd.title}
                  </div>
                </div>

                <div style={{ fontFamily: THEME.fonts.sans, fontSize: 18, color: THEME.colors.textMuted, lineHeight: 1.45 }}>
                  {bnd.fact}
                </div>
              </Card>
            </div>
          );
        })}
      </div>

      {/* Grounded Commitment Callout */}
      <Card
        variant="raised"
        style={{
          borderLeft: `4px solid ${THEME.colors.accentGreen}`,
          padding: '16px 24px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span style={{ fontFamily: THEME.fonts.sans, fontSize: 22, color: THEME.colors.textMain }}>
          <strong style={{ color: THEME.colors.accentGreen }}>Grounded Engineering:</strong> Reproducible sequences, deterministic state, and verifiable evidence over hype.
        </span>
        <Badge label="REPRODUCIBLE OVER HYPE" variant="green" size="sm" />
      </Card>
    </div>
  );
};
