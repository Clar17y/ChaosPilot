import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { THEME } from '../theme';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';

export const Scene04_BriefRequirements: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleSpring = spring({ frame, fps, config: { damping: 15 } });

  const panelSpring = spring({
    frame: frame - 40,
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
          <Badge label="STAGE 01 // BRIEF & REQUIREMENTS" variant="cyan" />
          <Badge label="REVISION PINNED" variant="green" />
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
          Start with the system.
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
          Save the system brief before launch. Each new run pins its brief revision, source, contract, and checks.
        </p>
      </div>

      {/* Brief & Requirements Workbench Panel */}
      <div
        style={{
          opacity: panelSpring,
          transform: `translateY(${interpolate(panelSpring, [0, 1], [30, 0])}px)`,
          display: 'grid',
          gridTemplateColumns: '1.2fr 1fr',
          gap: 24,
          margin: '20px 0',
        }}
      >
        {/* Left Column: System Contract Card */}
        <Card variant="surface" borderColor="rgba(105, 199, 219, 0.4)">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <span style={{ fontFamily: THEME.fonts.mono, fontSize: 18, color: THEME.colors.accentBright, fontWeight: 700 }}>
              SAVED SYSTEM BRIEF // ILLUSTRATIVE
            </span>
            <Badge label="CONTRACT LOCKED" variant="cyan" size="sm" />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ padding: '12px 16px', backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 8 }}>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 15, color: THEME.colors.textDim }}>TARGET SYSTEM</div>
              <div style={{ fontFamily: THEME.fonts.sans, fontSize: 22, fontWeight: 700, color: THEME.colors.textMain }}>
                Synthetic Trading Gateway
              </div>
            </div>

            <div style={{ padding: '12px 16px', backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 8 }}>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 15, color: THEME.colors.textDim }}>EXECUTABLE CONTRACT</div>
              <div style={{ fontFamily: THEME.fonts.mono, fontSize: 17, color: THEME.colors.accentGreen }}>
                ✓ Duplicate reports change accounting once<br />
                ✓ Accepted orders respect the credit limit
              </div>
            </div>
          </div>
        </Card>

        {/* Right Column: Context Clarification Card */}
        <Card variant="surface" borderColor="rgba(217, 168, 78, 0.4)">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <span style={{ fontFamily: THEME.fonts.mono, fontSize: 18, color: THEME.colors.accentAmber, fontWeight: 700 }}>
              REQUIREMENT SPECIFICATION
            </span>
            <Badge label="PROSE IS CONTEXT" variant="amber" size="sm" />
          </div>

          <div
            style={{
              fontFamily: THEME.fonts.sans,
              fontSize: 20,
              color: THEME.colors.textMuted,
              lineHeight: 1.5,
              padding: '16px',
              backgroundColor: 'rgba(0,0,0,0.3)',
              borderRadius: 8,
              height: 140,
              display: 'flex',
              alignItems: 'center',
            }}
          >
            Additional requirements give the investigator context. An executable check needs a concrete evaluator.
          </div>
        </Card>
      </div>

      {/* Footer Provenance Note */}
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
          <strong style={{ color: THEME.colors.accentBright }}>Evidence Foundation:</strong> New runs preserve the saved brief, source identity, contract, and evaluator.
        </span>
        <Badge label="AUDIT TRAIL SECURED" variant="cyan" size="sm" />
      </Card>
    </div>
  );
};
