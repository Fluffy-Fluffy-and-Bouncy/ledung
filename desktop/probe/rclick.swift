// A real right-click for the probe's "pictures" phase on macOS (#451): `swift rclick.swift <pid> <x> <y>` posts the
// system's rightMouseDown and rightMouseUp to that process at a screen point (points, top-left origin). Unlike
// Electron's input call, the click goes through the Mac's own event path, as Martin's mouse does. A locked screen
// swallows it: the page then sees no mouse event at all.
import CoreGraphics
import Foundation

let a = CommandLine.arguments
let pid = pid_t(Int32(a[1])!)
let p = CGPoint(x: Double(a[2])!, y: Double(a[3])!)
let src = CGEventSource(stateID: .hidSystemState)
for type in [CGEventType.rightMouseDown, .rightMouseUp] {
  let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .right)!
  e.setIntegerValueField(.mouseEventClickState, value: 1)
  e.postToPid(pid)
  usleep(60_000)
}
