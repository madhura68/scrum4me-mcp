import {rm} from 'node:fs/promises'

/** Temporary resources are secondary to the verified result or primary error.
 * Node retries transient recursive-removal failures with bounded linear backoff. */
export async function cleanupDispatchDirectory(root:string,phase:'verification'|'publication'|'preparation'):Promise<void>{
 try{await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100})}
 catch(error){
  // Never include filesystem paths, Git output or arbitrary error messages.
  const code=(error as NodeJS.ErrnoException|null)?.code
  const safeCode=typeof code==='string'&&/^E[A-Z0-9]{1,24}$/.test(code)?code:'UNKNOWN'
  try{console.warn(`[dispatch] ${phase} temporary directory cleanup failed (${safeCode}); manual cleanup may be required`)}catch{/* Logging must not replace the primary outcome either. */}
 }
}
