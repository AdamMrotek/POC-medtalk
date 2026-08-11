export interface ListItem {
  title: string;
  subtitle?: string;
}

interface Props {
  items: ListItem[];
  /** Renders a numbered circle marker per item. Set false for a plain dot-free list. */
  numbered?: boolean;
  className?: string;
}

/** Vertical list of title/subtitle rows, optionally numbered. */
export function List({ items, numbered = true, className }: Props) {
  const Tag = numbered ? "ol" : "ul";
  return (
    <Tag className={className ? `list ${className}` : "list"}>
      {items.map((item, index) => (
        <li className="list-item" key={item.title}>
          {numbered && (
            <span className="list-marker" aria-hidden="true">
              {index + 1}
            </span>
          )}
          <span className="list-text">
            <span className="list-title">{item.title}</span>
            {item.subtitle && <span className="list-subtitle">{item.subtitle}</span>}
          </span>
        </li>
      ))}
    </Tag>
  );
}
