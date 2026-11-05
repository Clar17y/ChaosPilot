import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { THEME } from '../theme';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';

export const Scene07_ExecuteFreshState: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleSpring = spring({ frame, fps, config: { damping: 15 } });

  const animStep1 = spring({ frame: frame - 40, fps, config: { damping: 14 } });
  const animStep2 = spring({ frame: frame - 100, fps, config: { damping: 14 } });
  const animStep3 = spring({ frame: frame - 160, fps, config: { damping: 14 } });

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
          <Badge label="STAGE 04 // EXECUTE & VERIFY" variant="amber" />
          <Badge label="ILLUSTRATIVE EXECUTION" variant="green" />
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
          Execute from a fresh state.
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
          Every candidate sequence runs against a freshly booted deterministic instance with strictly isolated state.
        </p>
      </div>

      {/* Execution Telemetry Matrix */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.2fr 1fr',
          gap: 24,
          margin: '16px 0',
        }}
      >
        {/* Left Column: Instance Event Deliveries */}
        <Card variant="surface" borderColor="rgba(217, 168, 78, 0.4)">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <span style={{ fontFamily: THEME.fonts.mono, fontSize: 18, color: THEME.colors.accentAmber, fontWeight: 700 }}>
              TEST RUNNER // FRESH INSTANCE
            </span>
            <Badge label="PROPOSALS FILTERED" variant="dim" size="sm" />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div
              style={{
                opacity: frame >= 40 ? animStep1 : 0,
                padding: '12px 16px',
                backgroundColor: 'rgba(0,0,0,0.3)',
                borderRadius: 8,
                display: 'flex',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ fontFamily: THEME.fonts.mono, fontSize: 16, color: THEME.colors.textMain }}>
                [SETUP] Start with fresh target state
              </span>
              <Badge label="CLEAN BOOT" variant="green" size="sm" />
            </div>

            <div
              style={{
                opacity: frame >= 100 ? animStep2 : 0,
                padding: '12px 16px',
                backgroundColor: 'rgba(0,0,0,0.3)',
                borderRadius: 8,
                display: 'flex',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ fontFamily: THEME.fonts.mono, fontSize: 16, color: THEME.colors.textMain }}>
                [DELIVER] Apply the validated action sequence
              </span>
              <Badge label="VALID" variant="cyan" size="sm" />
            </div>

            <div
              style={{
                opacity: frame >= 160 ? animStep3 : 0,
                padding: '12px 16px',
                backgroundColor: 'rgba(0,0,0,0.3)',
                borderRadius: 8,
                display: 'flex',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ fontFamily: THEME.fonts.mono, fontSize: 16, color: THEME.colors.textMuted }}>
                [REJECT] Invalid proposals are recorded separately
              </span>
              <Badge label="REJECTED" variant="dim" size="sm" />
            </div>
          </div>
        </Card>

        {/* Right Column: Invariant Checking Monitor */}
        <Card variant="surface" borderColor="rgba(224, 122, 106, 0.4)">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <span style={{ fontFamily: THEME.fonts.mono, fontSize: 18, color: THEME.colors.accentRed, fontWeight: 700 }}>
              INVARIANT EVALUATOR
            </span>
            <Badge label="CONTINUOUS ASSERTIONS" variant="coral" size="sm" />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ padding: '14px 18px', backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 8 }}>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 15, color: THEME.colors.textDim }}>EXPECTED INVARIANT</div>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 18, color: THEME.colors.accentGreen, marginTop: 4 }}>
                One execution changes used credit once
              </div>
            </div>

            <div style={{ padding: '14px 18px', backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 8 }}>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 15, color: THEME.colors.textDim }}>ILLUSTRATIVE FAILURE</div>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 18, color: THEME.colors.accentRed, marginTop: 4 }}>
                Duplicate changes used credit again
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Footer Banner */}
      <Card
        variant="raised"
        style={{
          borderLeft: `4px solid ${THEME.colors.accentAmber}`,
          padding: '16px 24px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span style={{ fontFamily: THEME.fonts.sans, fontSize: 22, color: THEME.colors.textMain }}>
          <strong style={{ color: THEME.colors.accentAmber }}>Fresh State:</strong> Each experiment starts independently. The evaluator checks recorded state and invariant outcomes.
        </span>
        <Badge label="FRESH INSTANCE" variant="green" size="sm" />
      </Card>
    </div>
  );
};
