# AGENTS.md

## Git Checks Before Changes

- Before modifying any code, configuration, or other project files, run `git status` to inspect the working tree.
- Preserve existing user changes. Do not revert, overwrite, or clean them up without authorization.

## Git and Descriptions

- Write Git commit messages in English.
- Use the commit format: `<type>: <brief English description>`.
- Commit types: `fix:` bug fixes; `feat:` new features; `ui:` UI layout, styling, or text changes; `refactor:` refactoring without behavior changes; `perf:` performance improvements; `docs:` documentation changes; `test:` test-related changes; `build:` build, packaging, dependency, or release configuration changes; `chore:` other maintenance changes.
- Descriptions, including commit messages, change descriptions, and replies, must not mention verification status, hardware validation status, or test execution.

## Verification Strategy

- Avoid excessive review. Keep review focused on the requested changes and material risks; do not repeat or broaden it without a concrete reason.
- Use Computer Use sparingly. Prefer source inspection and non-UI tools for routine checks; use UI automation only when a specific, material question requires it.
- The user may complete some visual and interaction checks manually. Avoid exhaustive UI walkthroughs and repeated screenshots; leave suitable checks to the user.
- Check UI layout and visual acceptance only at a window size of 1600×1200. Do not check other resolutions or responsive breakpoints.
- The preferred startup window size is 1600×1200. If the available screen work area is smaller, automatically shrink the startup window and keep it within the visible area.
- Do not run tests for ordinary changes.
- For larger changes only, run tests relevant to the changes before committing to Git.
- Before preparing a release or generating an installer, run the full test suite and production build.

## Code Comments

- When modifying or adding code, add brief English comments above functions and at important logic sections.

## Source References

- `D:\Users\dell\Desktop\pysoem-1.1.13\SOEM-2.0.0` contains the SOEM source code.
- `D:\Users\dell\Desktop\pysoem-1.1.13\pysoem-1.1.13` contains the PySOEM source code.
- Use SOEM as the primary source reference.
