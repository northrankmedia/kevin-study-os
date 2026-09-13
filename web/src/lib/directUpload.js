// Uploads a File directly to Supabase Storage using a signed upload URL
// minted server-side (POST .../upload-url, see api.js's getVoiceUploadUrl
// and CourseSetup.jsx's own inline equivalent for the syllabus flow) --
// bypasses our own Express API entirely for the binary transfer itself,
// which is the whole point: large files (syllabus PDFs up to 32MB, voice
// memos up to 25MB) must never pass through a serverless function's request
// body limit.
//
// A plain fetch() PUT works here too -- verified directly against Supabase
// Storage's own signed-upload-url route (supabase/storage's
// uploadSignedObject handler accepts a raw binary body with a Content-Type
// header, not only multipart/form-data). XMLHttpRequest is used instead of
// fetch() purely because fetch() has no upload-progress event, and this is
// used for exactly the large files where showing real progress matters.
//
// Resolves on a 2xx response, rejects with a plain Error otherwise (this
// is a storage-transport failure, not one of our own API's documented
// error shapes, so callers should show a generic "try again" message for
// it rather than treating it like a processing-endpoint error).
export function uploadFileDirectly(uploadUrl, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', uploadUrl)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.setRequestHeader('x-upsert', 'false')

    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total)
      }
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
      } else {
        reject(new Error(`Upload to storage failed (${xhr.status})`))
      }
    }
    xhr.onerror = () => reject(new Error('Upload to storage failed. Check your connection and try again.'))

    xhr.send(file)
  })
}
