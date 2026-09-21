import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'

// Must mirror the frontend's extension list (frontend/src/main.js) exactly --
// this schema is used to reconstruct a real ProseMirror node from Yjs state
// for git checkpointing (see server.js's checkpointToGit), and
// schema.nodeFromJSON throws "Unknown node type" for anything the frontend
// can produce that this list doesn't also know about (verified directly:
// this is exactly what broke when Image was added to the frontend but not
// here -- every checkpoint for a doc containing an image failed outright).
export const schema = getSchema([StarterKit, Image])
