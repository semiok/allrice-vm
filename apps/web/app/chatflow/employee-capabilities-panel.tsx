'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import {
  EmployeeSkillsHost,
  useEmployeeSkillsHostView,
  type EmployeeSkillsHostProps,
} from './employee-skills-host';
import css from './employee-capabilities-panel.module.css';
import { useCapabilityEscape } from './use-capability-escape';

type CapabilitiesBodyProps = {
  employeeName: string;
  scopeKey: string;
  active: boolean;
  onRead: () => void;
  layer?: ReactNode;
  showSkills: boolean;
  children: ReactNode;
};

/** The native Dock owns navigation/focus. Both placements use the same Skill
 * reader, list and detail components. */
export function EmployeeCapabilitiesPanel({
  skillsHost,
  ...props
}: CapabilitiesBodyProps & {
  skillsHost?: Omit<EmployeeSkillsHostProps, 'children'>;
}) {
  if (!skillsHost) return <EmployeeCapabilitiesBody {...props} />;
  return (
    <EmployeeSkillsHost {...skillsHost}>
      {(skills) => (
        <EmployeeCapabilitiesBody {...props}>
          {props.children ?? skills.section}
        </EmployeeCapabilitiesBody>
      )}
    </EmployeeSkillsHost>
  );
}

function EmployeeCapabilitiesBody({
  employeeName,
  scopeKey,
  active,
  onRead,
  layer,
  showSkills,
  children,
}: CapabilitiesBodyProps) {
  const read = useRef(onRead);
  const content = useRef<HTMLDivElement>(null);
  const listFocus = useRef<HTMLElement | null>(null);
  const hadLayer = useRef(false);
  const skills = useEmployeeSkillsHostView();
  const skillLayer =
    showSkills && !skills?.layer?.small ? skills?.layer : undefined;
  const layerKey = skillLayer?.navigationKey;
  const hasLayer = Boolean(layer || skillLayer);
  useCapabilityEscape(content, Boolean(active && skillLayer), () => {
    if (skillLayer && !skillLayer.blocked) skillLayer.onBack();
  });
  read.current = onRead;
  useEffect(() => {
    if (active) read.current();
  }, [active, scopeKey]);
  useEffect(() => {
    if (active && layerKey)
      content.current
        ?.querySelector<HTMLElement>('[data-modal-autofocus]')
        ?.focus({ preventScroll: true });
    else if (active && !hasLayer && hadLayer.current) {
      const previous = listFocus.current;
      if (previous?.isConnected && content.current?.contains(previous))
        previous.focus({ preventScroll: true });
      else
        (
          content.current?.querySelector<HTMLElement>(
            'button:not([disabled])',
          ) ?? content.current
        )?.focus({ preventScroll: true });
    }
    hadLayer.current = hasLayer;
  }, [active, layerKey, hasLayer]);
  return (
    <section
      className={css.panel}
      aria-label={`${employeeName} · 能力`}
      data-employee-capabilities
    >
      <header className={css.identity}>
        <div className={css.avatar} aria-hidden="true">
          {employeeName.slice(0, 1)}
        </div>
        <div>
          <h2>{employeeName} · 能力</h2>
          <p>插件、工作场景和技能</p>
        </div>
      </header>
      <div
        ref={content}
        tabIndex={-1}
        className={css.content}
        onFocusCapture={(event) => {
          if (!hasLayer && event.target instanceof HTMLElement)
            listFocus.current = event.target;
        }}
      >
        {layer || skillLayer ? (
          <div className={css.layer}>{layer ?? skillLayer?.content}</div>
        ) : (
          <div className={css.body}>{children}</div>
        )}
      </div>
    </section>
  );
}
