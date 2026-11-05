import React from 'react';
import { Composition } from 'remotion';
import { ChaosPilotOverview } from './Composition';
import { TOTAL_FRAMES, FPS, WIDTH, HEIGHT } from './theme';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="ChaosPilotOverview"
      component={ChaosPilotOverview}
      durationInFrames={TOTAL_FRAMES}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
    />
  );
};
