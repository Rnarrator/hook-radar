import type { Filters } from "../model";
import { discoveryCategories, discoveryDynamicFeePatch } from "../discovery";
import { ArrowRight, ChevronDown } from "./Icons";
import { SavedDiscoveryFilters } from "./SavedDiscoveryFilters";
import "./discovery-guide.css";

export interface DiscoveryGuideProps {
  filters: Filters;
  onChoose: (patch: Partial<Filters>) => void;
  onLaunchpads: () => void;
  disabled?: boolean;
}

/** Fast, composable entry points into the same directory filters used by search. */
export function DiscoveryGuide({
  filters,
  onChoose,
  onLaunchpads,
  disabled = false,
}: DiscoveryGuideProps) {
  const selectedCategory = discoveryCategories.find(
    (category) => category.value === filters.category,
  );
  return (
    <section className="discovery-guide" aria-label="Guided hook discovery">
      <div className="discovery-guide-heading">
        <span className="discovery-guide-label">Browse by use case</span>
        <button
          type="button"
          className="discovery-launchpads"
          onClick={onLaunchpads}
          disabled={disabled}
          title="Explore launchpads and token launch infrastructure using v4"
        >
          Launchpads <ArrowRight size={14} />
        </button>
      </div>
      <div
        className="discovery-categories"
        role="group"
        aria-label="Browse by use case"
      >
        {discoveryCategories.map((category) => (
          <button
            type="button"
            key={category.value}
            aria-pressed={filters.category === category.value}
            title={category.detail}
            disabled={disabled}
            onClick={() => onChoose({ category: category.value })}
          >
            {category.label}
          </button>
        ))}
      </div>
      <label className="discovery-category-select">
        <span className="sr-only">Browse by use case</span>
        <select
          value={filters.category}
          disabled={disabled}
          onChange={(event) => onChoose({ category: event.target.value })}
        >
          {discoveryCategories.map((category) => (
            <option key={category.value} value={category.value}>
              {category.label}
            </option>
          ))}
        </select>
        <ChevronDown size={14} />
      </label>
      <div
        className="discovery-quickviews"
        role="group"
        aria-label="Quick views"
      >
        <button
          type="button"
          aria-pressed={filters.property === "dynamic"}
          title="Show hooks marked as dynamic fee hooks in the registry. Other filters still apply."
          disabled={disabled}
          onClick={() => onChoose(discoveryDynamicFeePatch(filters))}
        >
          Dynamic fees
        </button>
        <SavedDiscoveryFilters
          filters={filters}
          onChoose={onChoose}
          disabled={disabled}
        />
      </div>
      {selectedCategory && filters.category !== "all" && (
        <p className="discovery-category-context">{selectedCategory.detail}</p>
      )}
    </section>
  );
}
