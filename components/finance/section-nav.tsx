'use client';

/**
 * In-page navigation for a long dashboard.
 *
 * The Finance page is nine blocks deep; a reader looking for the balance sheet
 * should not have to scroll past the P&L to find it. The bar sticks under the
 * global controls and marks whichever section is in view.
 */
import { useEffect, useState } from 'react';

export function SectionNav({ sections }: { sections: Array<{ id: string; label: string }> }) {
  const [active, setActive] = useState(sections[0]?.id ?? '');

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-120px 0px -55% 0px' },
    );
    for (const section of sections) {
      const element = document.getElementById(section.id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [sections]);

  return (
    <nav
      aria-label="Sections on this page"
      className="md:sticky md:top-[53px] z-10 -mx-1 flex gap-1 overflow-x-auto rounded-[var(--radius)] border p-1 backdrop-blur"
      style={{ background: 'color-mix(in srgb, var(--surface-1) 90%, transparent)', borderColor: 'var(--border)' }}
    >
      {sections.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          className="whitespace-nowrap rounded-[6px] px-2.5 py-1 text-[11.5px] font-medium transition-colors"
          style={{
            background: active === section.id ? 'var(--text-primary)' : 'transparent',
            color: active === section.id ? 'var(--text-inverse)' : 'var(--text-secondary)',
          }}
          aria-current={active === section.id ? 'true' : undefined}
        >
          {section.label}
        </a>
      ))}
    </nav>
  );
}
