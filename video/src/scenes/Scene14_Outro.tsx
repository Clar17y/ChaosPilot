import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { THEME } from '../theme';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';

export const Scene14_Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleSpring = spring({ frame, fps, config: { damping: 14 } });
  const terminalSpring = spring({ frame: frame - 40, fps, config: { damping: 14 } });

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: 1920,
        height: 1080,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '80px',
      }}
    >
      {/* Brand & Headline Core */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          opacity: titleSpring,
          transform: `scale(${0.92 + titleSpring * 0.08})`,
        }}
      >
        <div style={{ marginBottom: 20 }}>
          <Badge label="LOCAL INVESTIGATION WORKBENCH" variant="cyan" />
        </div>

        <h1
          style={{
            fontFamily: THEME.fonts.sans,
            fontSize: 88,
            fontWeight: 800,
            letterSpacing: '-0.03em',
            color: THEME.colors.textMain,
            lineHeight: 1.05,
            margin: 0,
            textShadow: '0 0 35px rgba(105, 199, 219, 0.3)',
          }}
        >
          ChaosPilot
        </h1>

        <div
          style={{
            marginTop: 20,
            fontFamily: THEME.fonts.sans,
            fontSize: 40,
            fontWeight: 650,
            color: THEME.colors.accentBright,
            letterSpacing: '-0.01em',
          }}
        >
          Ask what can fail. Leave with a reproduction.
        </div>

        <div
          style={{
            marginTop: 14,
            fontFamily: THEME.fonts.sans,
            fontSize: 26,
            color: THEME.colors.textMuted,
          }}
        >
          Start locally. Inspect the evidence.
        </div>
      </div>

      {/* Terminal Launch Instructions */}
      <div
        style={{
          marginTop: 40,
          opacity: frame >= 40 ? terminalSpring : 0,
          transform: `translateY(${interpolate(terminalSpring, [0, 1], [30, 0])}px)`,
          width: 780,
        }}
      >
        <Card
          variant="surface"
          borderColor="rgba(105, 199, 219, 0.4)"
          style={{
            padding: '20px 28px',
            backgroundColor: 'rgba(6, 10, 16, 0.95)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <span style={{ fontFamily: THEME.fonts.mono, fontSize: 16, color: THEME.colors.textDim }}>
              TERMINAL // LOCAL WORKSPACE
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: '#e07a6a' }} />
              <span style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: '#d9a84e' }} />
              <span style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: '#4fd19b' }} />
            </div>
          </div>

          <div
            style={{
              fontFamily: THEME.fonts.mono,
              fontSize: 21,
              lineHeight: 1.7,
              color: THEME.colors.textMain,
            }}
          >
            <div>
              <span style={{ color: THEME.colors.accentCyan }}>$ </span>
              <span style={{ color: THEME.colors.textMain }}>npm ci</span>
            </div>
            <div>
              <span style={{ color: THEME.colors.accentCyan }}>$ </span>
              <span style={{ color: THEME.colors.textMain }}>npm run dev</span>
            </div>
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(130, 170, 200, 0.15)' }}>
              <span style={{ color: THEME.colors.accentGreen }}>→ Local Workbench: </span>
              <span style={{ color: THEME.colors.accentBright, textDecoration: 'underline' }}>
                http://127.0.0.1:4310
              </span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
};
