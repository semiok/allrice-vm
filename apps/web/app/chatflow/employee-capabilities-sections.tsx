'use client';

import type { ComponentProps } from 'react';
import { BrandMediaPluginSection } from './brand-media/frontend-wiring';
import { EmployeeSceneList } from './employee-scene-dialog';
import { useEmployeeSkillsHostView } from './employee-skills-host';
import css from './employee-capabilities-panel.module.css';

export function EmployeeCapabilitiesSections({
  plugins,
  scenes,
  onSkillNavigate,
}: {
  plugins: ComponentProps<typeof BrandMediaPluginSection>;
  scenes: Omit<ComponentProps<typeof EmployeeSceneList>, 'embedded'>;
  onSkillNavigate?: () => void;
}) {
  const skills = useEmployeeSkillsHostView();
  return (
    <div className={css.sections}>
      <BrandMediaPluginSection {...plugins} />
      <EmployeeSceneList {...scenes} embedded />
      {skills?.renderSection(onSkillNavigate)}
    </div>
  );
}
