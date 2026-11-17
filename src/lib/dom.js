/**
 * Small DOM questions the keyboard code keeps asking.
 *
 * `isEditable` is the important one: a bare-key shortcut (`?`, `/`, a letter)
 * must never fire while somebody is typing. AppRail and HubLayout each carried
 * their own copy of this four-line check, which is how one of them ends up
 * forgetting `contentEditable` the day a field is added.
 */
export function isEditable(target) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  )
}
