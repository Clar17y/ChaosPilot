import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { THEME } from '../theme';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';

export const Scene05_BoundedPlan: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleSpring = spring({ frame, fps, config: { damping: 15 } });

  const pins = [
    { title: 'Source Code', desc: 'selected implementation identity', icon: '⌗', color: THEME.colors.accentCyan },
    { title: 'System Brief', desc: 'saved requirements revision', icon: '☰', color: THEME.colors.accentBright },
    { title: 'Contract', desc: 'supported executable checks', icon: '⚖', color: THEME.colors.accentGreen },
    { title: 'Evaluator', desc: 'deterministic assertion engine', icon: '⚙', color: THEME.colors.accentViolet },
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
          <Badge label="STAGE 02 // PREPARE INVESTIGATION" variant="cyan" />
          <Badge label="BOUNDED EXECUTION" variant="dim" />
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
          Prepare a bounded investigation.
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
          Review scenario links and run limits. The saved plan pins the source, brief, contract, and evaluator.
        </p>
      </div>

      {/* 4 Pinned Artifacts */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 20,
          margin: '20px 0',
        }}
      >
        {pins.map((pin, idx) => {
          const pinSpring = spring({
            frame: frame - (20 + idx * 25),
            fps,
            config: { damping: 14 },
          });
          const prog = frame >= 20 + idx * 25 ? pinSpring : 0;

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
                borderColor={pin.color}
                style={{
                  borderTop: `4px solid ${pin.color}`,
                  height: 200,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                }}
              >
                <div>
                  <div style={{ fontSize: 28, color: pin.color, marginBottom: 10 }}>{pin.icon}</div>
                  <div style={{ fontFamily: THEME.fonts.sans, fontSize: 24, fontWeight: 700, color: THEME.colors.textMain }}>
                    {pin.title}
                  </div>
                </div>
                <div style={{ fontFamily: THEME.fonts.mono, fontSize: 16, color: THEME.colors.textMuted }}>
                  {pin.desc}
                </div>
              </Card>
            </div>
          );
        })}
      </div>

      {/* Scenario State Distinction Banner (Planned vs Exercised) */}
      <Card
        variant="raised"
        style={{
          borderLeft: `4px solid ${THEME.colors.accentViolet}`,
          padding: '18px 26px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <span style={{ fontFamily: THEME.fonts.sans, fontSize: 22, color: THEME.colors.textMain }}>
            <strong style={{ color: THEME.colors.accentBright }}>Scenario States:</strong> Planned scenarios and exercised executions remain explicitly distinct audit states.
          </span>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <Badge label="PLANNED" variant="cyan" size="sm" />
          <Badge label="EXERCISED" variant="green" size="sm" />
          <Badge label="CONFIRMED" variant="dim" size="sm" />
        </div>
      </Card>
    </div>
  );
};
