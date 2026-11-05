import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { THEME } from '../theme';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';

export const Scene11_BaselinesVsExplore: React.FC = () => {
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
          <Badge label="COMPLEMENTARY METHODOLOGIES" variant="cyan" />
          <Badge label="ZERO MODEL CALLS FOR BASELINES" variant="green" />
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
          Known checks. New questions.
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
          Functional baselines check known behaviours. Investigations explore additional event sequences and failure hypotheses.
        </p>
      </div>

      {/* Dual Complementary Paths */}
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
        {/* Path 1: Functional Baselines */}
        <Card variant="surface" borderColor="rgba(79, 209, 155, 0.4)">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
            <span style={{ fontFamily: THEME.fonts.sans, fontSize: 24, fontWeight: 700, color: THEME.colors.accentGreen }}>
              Functional Test Baselines
            </span>
            <Badge label="DETERMINISTIC SUITE" variant="green" size="sm" />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ padding: '14px 16px', backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 8 }}>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 15, color: THEME.colors.textDim }}>PURPOSE & SCOPE</div>
              <div style={{ fontFamily: THEME.fonts.sans, fontSize: 18, color: THEME.colors.textMain, marginTop: 4 }}>
                Curated positive and negative suites verifying expected contract adherence.
              </div>
            </div>

            <div style={{ padding: '14px 16px', backgroundColor: 'rgba(79, 209, 155, 0.1)', borderRadius: 8 }}>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 15, color: THEME.colors.accentGreen }}>COST & OVERHEAD</div>
              <div style={{ fontFamily: THEME.fonts.sans, fontSize: 18, color: THEME.colors.textMain, marginTop: 4 }}>
                Deterministic execution. Zero AI model calls. Recorded checks and outcomes.
              </div>
            </div>
          </div>
        </Card>

        {/* Path 2: Exploratory Investigations */}
        <Card variant="surface" borderColor="rgba(105, 199, 219, 0.4)">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
            <span style={{ fontFamily: THEME.fonts.sans, fontSize: 24, fontWeight: 700, color: THEME.colors.accentBright }}>
              Exploratory Investigations
            </span>
            <Badge label="HYPOTHESIS-DRIVEN" variant="cyan" size="sm" />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ padding: '14px 16px', backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 8 }}>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 15, color: THEME.colors.textDim }}>PURPOSE & SCOPE</div>
              <div style={{ fontFamily: THEME.fonts.sans, fontSize: 18, color: THEME.colors.textMain, marginTop: 4 }}>
                Probe event combinations, duplicate delivery, and boundary conditions.
              </div>
            </div>

            <div style={{ padding: '14px 16px', backgroundColor: 'rgba(105, 199, 219, 0.1)', borderRadius: 8 }}>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 15, color: THEME.colors.accentBright }}>BOUNDED SEARCH</div>
              <div style={{ fontFamily: THEME.fonts.sans, fontSize: 18, color: THEME.colors.textMain, marginTop: 4 }}>
                Strict experiment quotas and budget limits prevent runaway testing loops.
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Convergence Banner */}
      <Card
        variant="raised"
        style={{
          borderLeft: `4px solid ${THEME.colors.accentCyan}`,
          padding: '16px 24px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span style={{ fontFamily: THEME.fonts.sans, fontSize: 22, color: THEME.colors.textMain }}>
          <strong style={{ color: THEME.colors.accentBright }}>Inspectable Results:</strong> Both approaches preserve expected checks and recorded outcomes for review.
        </span>
        <Badge label="CONVERGENT EVIDENCE" variant="cyan" size="sm" />
      </Card>
    </div>
  );
};
