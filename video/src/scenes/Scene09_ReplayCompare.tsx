import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { THEME } from '../theme';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';

export const Scene09_ReplayCompare: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleSpring = spring({ frame, fps, config: { damping: 15 } });

  const cardSpring = spring({
    frame: frame - 30,
    fps,
    config: { damping: 14 },
  });

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
          <Badge label="STAGE 06 // REPLAY & COMPARISON" variant="green" />
          <Badge label="SCHEMATIC EXAMPLE // ILLUSTRATIVE" variant="dim" />
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
          Replay it. Compare it.
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
          Rerun the same sequence and check its recorded invariants. Then compare the result with the clean target.
        </p>
      </div>

      {/* Side-by-Side Controlled Experiment Matrix */}
      <div
        style={{
          opacity: cardSpring,
          transform: `translateY(${interpolate(cardSpring, [0, 1], [30, 0])}px)`,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 28,
          margin: '20px 0',
        }}
      >
        {/* Candidate Target Under Test */}
        <Card variant="surface" borderColor="rgba(224, 122, 106, 0.4)">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
            <span style={{ fontFamily: THEME.fonts.sans, fontSize: 24, fontWeight: 700, color: THEME.colors.accentRed }}>
              Candidate Target (Under Test)
            </span>
            <Badge label="REPRODUCED BUG" variant="coral" size="sm" />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ padding: '14px 16px', backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 8 }}>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 15, color: THEME.colors.textDim }}>PINNED SOURCE</div>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 18, color: THEME.colors.textMain }}>
                Selected candidate implementation
              </div>
            </div>

            <div style={{ padding: '14px 16px', backgroundColor: 'rgba(224, 122, 106, 0.1)', borderRadius: 8 }}>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 15, color: THEME.colors.accentRed }}>EVALUATION OUTCOME</div>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 18, color: THEME.colors.accentRed, fontWeight: 600 }}>
                FAIL: Repeated execution changes accounting again
              </div>
            </div>
          </div>
        </Card>

        {/* Clean Control Reference Target */}
        <Card variant="surface" borderColor="rgba(79, 209, 155, 0.4)">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
            <span style={{ fontFamily: THEME.fonts.sans, fontSize: 24, fontWeight: 700, color: THEME.colors.accentGreen }}>
              Clean Target (Reference Baseline)
            </span>
            <Badge label="CONTROL PASSES" variant="green" size="sm" />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ padding: '14px 16px', backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 8 }}>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 15, color: THEME.colors.textDim }}>PINNED SOURCE</div>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 18, color: THEME.colors.textMain }}>
                Clean reference implementation
              </div>
            </div>

            <div style={{ padding: '14px 16px', backgroundColor: 'rgba(79, 209, 155, 0.1)', borderRadius: 8 }}>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 15, color: THEME.colors.accentGreen }}>EVALUATION OUTCOME</div>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 18, color: THEME.colors.accentGreen, fontWeight: 600 }}>
                PASS: Repeated execution leaves accounting unchanged
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Confirmation Callout */}
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
          <strong style={{ color: THEME.colors.accentGreen }}>Verify the Finding:</strong> Confirm the recorded failure with exact replay and the corresponding clean comparison.
        </span>
        <Badge label="CONFIRMED FINDING" variant="green" size="sm" />
      </Card>
    </div>
  );
};
