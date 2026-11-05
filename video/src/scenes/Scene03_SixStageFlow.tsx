import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { THEME } from '../theme';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';

export const Scene03_SixStageFlow: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleSpring = spring({ frame, fps, config: { damping: 15 } });

  const stages = [
    { num: '01', name: 'Brief', desc: 'Target & Contract', color: THEME.colors.accentCyan, delay: 20 },
    { num: '02', name: 'Plan', desc: 'Bounded Budget', color: THEME.colors.accentCyan, delay: 50 },
    { num: '03', name: 'Propose', desc: 'Negative Sequences', color: THEME.colors.accentViolet, delay: 80 },
    { num: '04', name: 'Execute', desc: 'Fresh Instances', color: THEME.colors.accentAmber, delay: 110 },
    { num: '05', name: 'Verify', desc: 'Check Invariants', color: THEME.colors.accentRed, delay: 140 },
    { num: '06', name: 'Replay', desc: 'Clean Control Test', color: THEME.colors.accentGreen, delay: 170 },
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
          <Badge label="INVESTIGATION LIFECYCLE" variant="cyan" />
          <Badge label="DETERMINISTIC PIPELINE" variant="dim" />
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
          From a question to a reproduction.
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
          Start with a hypothesis. Test it. Keep any checked reproduction.
        </p>
      </div>

      {/* Six-Stage Animated Flow */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(6, 1fr)',
          gap: 16,
          alignItems: 'center',
          position: 'relative',
          margin: '20px 0',
        }}
      >
        {stages.map((stg, idx) => {
          const stgSpring = spring({
            frame: frame - stg.delay,
            fps,
            config: { damping: 14 },
          });
          const isVisible = frame >= stg.delay;
          const prog = isVisible ? stgSpring : 0;

          return (
            <div
              key={idx}
              style={{
                opacity: prog,
                transform: `scale(${interpolate(prog, [0, 1], [0.85, 1])}) translateY(${interpolate(prog, [0, 1], [20, 0])}px)`,
                position: 'relative',
              }}
            >
              <Card
                variant="surface"
                borderColor={stg.color}
                style={{
                  borderTop: `4px solid ${stg.color}`,
                  height: 240,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  padding: '20px 18px',
                }}
              >
                <div>
                  <div
                    style={{
                      fontFamily: THEME.fonts.mono,
                      fontSize: 16,
                      color: stg.color,
                      fontWeight: 700,
                      marginBottom: 10,
                    }}
                  >
                    STAGE {stg.num}
                  </div>
                  <div
                    style={{
                      fontFamily: THEME.fonts.sans,
                      fontSize: 28,
                      fontWeight: 750,
                      color: THEME.colors.textMain,
                    }}
                  >
                    {stg.name}
                  </div>
                </div>

                <div
                  style={{
                    fontFamily: THEME.fonts.sans,
                    fontSize: 18,
                    color: THEME.colors.textMuted,
                    lineHeight: 1.3,
                  }}
                >
                  {stg.desc}
                </div>
              </Card>

              {/* Arrow connector between stages */}
              {idx < stages.length - 1 && (
                <div
                  style={{
                    position: 'absolute',
                    right: -12,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    zIndex: 10,
                    color: THEME.colors.textDim,
                    fontSize: 20,
                  }}
                >
                  →
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Outcome Banner */}
      <Card
        variant="raised"
        style={{
          borderLeft: `4px solid ${THEME.colors.accentGreen}`,
          padding: '18px 26px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span style={{ fontFamily: THEME.fonts.sans, fontSize: 24, color: THEME.colors.textMain }}>
          <strong style={{ color: THEME.colors.accentGreen }}>Evidence Goal:</strong> Saved inputs, recorded outcomes, exact replay, and a clean comparison.
        </span>
        <Badge label="INDEPENDENT REPLAY READY" variant="green" size="sm" />
      </Card>
    </div>
  );
};
