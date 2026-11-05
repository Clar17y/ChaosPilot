import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { THEME } from '../theme';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';

export const Scene08_DuplicateNotTwice: React.FC = () => {
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
          <Badge label="INVARIANT FAILURE INVESTIGATION" variant="coral" />
          <Badge label="ILLUSTRATIVE TRADING EXAMPLE" variant="dim" />
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
          A duplicate should not count twice.
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
          When the same execution report is received twice, the contract demands exactly one economic accounting update.
        </p>
      </div>

      {/* Comparison Grid: Expected vs Observed */}
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
        {/* Correct Contract Behavior */}
        <Card variant="surface" borderColor="rgba(79, 209, 155, 0.4)">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
            <span style={{ fontFamily: THEME.fonts.sans, fontSize: 24, fontWeight: 700, color: THEME.colors.accentGreen }}>
              Expected Specification
            </span>
            <Badge label="INVARIANT PRESERVED" variant="green" size="sm" />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ padding: '16px', backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 8 }}>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 16, color: THEME.colors.textDim }}>ECONOMIC EFFECT</div>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 22, color: THEME.colors.textMain, marginTop: 4 }}>
                Used credit changes once
              </div>
            </div>

            <div style={{ padding: '16px', backgroundColor: 'rgba(79, 209, 155, 0.1)', borderRadius: 8 }}>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 16, color: THEME.colors.accentGreen }}>DEDUPLICATION FILTER</div>
              <div style={{ fontFamily: THEME.fonts.sans, fontSize: 18, color: THEME.colors.textMain, marginTop: 4 }}>
                The repeated execution leaves accounting unchanged.
              </div>
            </div>
          </div>
        </Card>

        {/* Faulty Candidate Behavior */}
        <Card variant="surface" borderColor="rgba(224, 122, 106, 0.5)">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
            <span style={{ fontFamily: THEME.fonts.sans, fontSize: 24, fontWeight: 700, color: THEME.colors.accentRed }}>
              Illustrative Faulty Behaviour
            </span>
            <Badge label="INVARIANT VIOLATION" variant="coral" size="sm" />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ padding: '16px', backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 8 }}>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 16, color: THEME.colors.textDim }}>ERRONEOUS ECONOMIC EFFECT</div>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 22, color: THEME.colors.accentRed, marginTop: 4 }}>
                Used credit changes twice
              </div>
            </div>

            <div style={{ padding: '16px', backgroundColor: 'rgba(224, 122, 106, 0.1)', borderRadius: 8 }}>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 16, color: THEME.colors.accentRed }}>DUPLICATE ACCOUNTING</div>
              <div style={{ fontFamily: THEME.fonts.sans, fontSize: 18, color: THEME.colors.textMain, marginTop: 4 }}>
                Reprocessing the same execution breaks the accounting check.
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Footer Banner */}
      <Card
        variant="raised"
        style={{
          borderLeft: `4px solid ${THEME.colors.accentRed}`,
          padding: '16px 24px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span style={{ fontFamily: THEME.fonts.sans, fontSize: 22, color: THEME.colors.textMain }}>
          <strong style={{ color: THEME.colors.accentRed }}>Expected vs Observed:</strong> A recorded invariant violation identifies the failed check. Replay tests whether it reproduces.
        </span>
        <Badge label="VIOLATION ISOLATED" variant="coral" size="sm" />
      </Card>
    </div>
  );
};
