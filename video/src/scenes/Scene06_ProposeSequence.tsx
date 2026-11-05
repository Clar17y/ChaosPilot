import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { THEME } from '../theme';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';

export const Scene06_ProposeSequence: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleSpring = spring({ frame, fps, config: { damping: 15 } });

  const steps = [
    { num: 'STEP 1', action: 'Configure a fresh trading target', tag: 'SETUP' },
    { num: 'STEP 2', action: 'Submit an order within the credit limit', tag: 'ORDER' },
    { num: 'STEP 3', action: 'Deliver an execution report', tag: 'FILL' },
    { num: 'STEP 4', action: 'Deliver the same execution report again', tag: 'DUPLICATE' },
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
          <Badge label="STAGE 03 // PROPOSE SEQUENCE" variant="violet" />
          <Badge label="SCHEMATIC PROPOSAL // ILLUSTRATIVE" variant="dim" />
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
          Propose the sequence that tests the assumption.
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
          Model-generated sequences reason directly over target source and contracts to construct targeted negative stress paths.
        </p>
      </div>

      {/* Action Sequence Inspection Panel */}
      <Card variant="surface" borderColor="rgba(169, 150, 247, 0.35)" style={{ margin: '16px 0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ fontFamily: THEME.fonts.mono, fontSize: 18, color: THEME.colors.accentViolet, fontWeight: 700 }}>
              HYPOTHESIS: DUPLICATE EXECUTION CHANGES ACCOUNTING
            </span>
          </div>
          <Badge label="SELECTED TARGET SOURCE" variant="dim" size="sm" />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {steps.map((st, idx) => {
            const stepSpring = spring({
              frame: frame - (30 + idx * 25),
              fps,
              config: { damping: 14 },
            });
            const prog = frame >= 30 + idx * 25 ? stepSpring : 0;

            return (
              <div
                key={idx}
                style={{
                  opacity: prog,
                  transform: `translateX(${interpolate(prog, [0, 1], [-20, 0])}px)`,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '14px 20px',
                  backgroundColor: 'rgba(0,0,0,0.3)',
                  borderLeft: `4px solid ${idx === 3 ? THEME.colors.accentRed : THEME.colors.accentCyan}`,
                  borderRadius: '0 8px 8px 0',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                  <span style={{ fontFamily: THEME.fonts.mono, fontSize: 16, color: THEME.colors.textDim, width: 80 }}>
                    {st.num}
                  </span>
                  <span
                    style={{
                      fontFamily: THEME.fonts.mono,
                      fontSize: 19,
                      color: idx === 3 ? THEME.colors.accentRed : THEME.colors.textMain,
                    }}
                  >
                    {st.action}
                  </span>
                </div>
                <Badge label={st.tag} variant={idx === 3 ? 'coral' : 'dim'} size="sm" />
              </div>
            );
          })}
        </div>
      </Card>

      {/* Attribution Note */}
      <Card
        variant="raised"
        style={{
          borderLeft: `4px solid ${THEME.colors.accentViolet}`,
          padding: '16px 24px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span style={{ fontFamily: THEME.fonts.sans, fontSize: 22, color: THEME.colors.textMain }}>
          <strong style={{ color: THEME.colors.accentViolet }}>Source Context:</strong> The model receives the selected implementation, its contract, and observations from the investigation.
        </span>
        <Badge label="SOURCE-AWARE PROPOSALS" variant="violet" size="sm" />
      </Card>
    </div>
  );
};
