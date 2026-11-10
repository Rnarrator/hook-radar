import { Modal } from "./Primitives";
import { paletteShortcutLabel } from "./CommandPalette";
import "./shortcuts-dialog.css";

/** The keys the page already answers to, in one place. Every row describes a
 * shortcut that exists today; nothing here adds behaviour of its own. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const groups: { title: string; rows: [string[], string][] }[] = [
    {
      title: "Anywhere",
      rows: [
        [["/"], "Search hooks and addresses"],
        [
          [paletteShortcutLabel()],
          "Jump to a page, network, launchpad or project",
        ],
        [["?"], "Show this list"],
        [["Esc"], "Close a panel, a project or the jump menu"],
      ],
    },
    {
      title: "In the jump menu",
      rows: [
        [["↑", "↓"], "Move between results"],
        [["Home", "End"], "First or last result, while the search is empty"],
        [["Enter"], "Open the highlighted result"],
      ],
    },
  ];
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <div className="modal-body shortcuts-body">
        <h2>Keyboard shortcuts</h2>
        <p className="intro-copy">
          Shortcuts work when you are not typing in a field.
        </p>
        {groups.map((group) => (
          <section key={group.title} aria-label={group.title}>
            <h3>{group.title}</h3>
            <dl className="shortcut-list">
              {group.rows.map(([keys, action]) => (
                <div key={action}>
                  <dt>
                    {keys.map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </dt>
                  <dd>{action}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
