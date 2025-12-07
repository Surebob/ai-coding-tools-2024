import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const config = JSON.parse(fs.readFileSync("/workspace/config.json", "utf-8"));
const startTime = Date.now();

// === WEBSOCKET LOG STREAMING ===
// Opens ONE WebSocket to MonitorDO, sends ALL logs over it
// No subrequest limit since WebSocket messages don't count!

let logSocket = null;
let logSocketReady = false;
let logBuffer = [];

async function connectLogSocket() {
  if (!config.LOG_WS_URL || logSocket) return;
  
  return new Promise((resolve) => {
    try {
      logSocket = new WebSocket(config.LOG_WS_URL);
      
      logSocket.onopen = () => {
        logSocketReady = true;
        // Flush buffered logs
        for (const line of logBuffer) {
          logSocket.send(line);
        }
        logBuffer = [];
        resolve(true);
      };
      
      logSocket.onclose = () => {
        logSocketReady = false;
        logSocket = null;
      };
      
      logSocket.onerror = () => {
        logSocketReady = false;
        resolve(false);
      };
      
      // Timeout if WebSocket doesn't connect in 5 seconds
      setTimeout(() => resolve(false), 5000);
    } catch (e) {
      console.log("[LOG_WS_ERROR] " + e.message);
      resolve(false);
    }
  });
}

function closeLogSocket() {
  if (logSocket) {
    try { logSocket.close(); } catch {}
    logSocket = null;
    logSocketReady = false;
  }
}

async function log(type, message) {
  const logLine = "[TS:" + Date.now() + "][" + config.TASK_ID + "][" + type + "] " + message;
  console.log(logLine); // Always console.log (for local wrangler mode)
  
  // Production mode: send over WebSocket
  if (config.LOG_WS_URL) {
    // Connect on first log
    if (!logSocket && !logSocketReady) {
      await connectLogSocket();
    }
    
    // Send or buffer
    if (logSocketReady && logSocket) {
      try {
        logSocket.send(logLine);
      } catch {
        logBuffer.push(logLine);
      }
    } else {
      logBuffer.push(logLine);
    }
  }
}

function elapsed() { return Date.now() - startTime; }

// ============================================================================
// TOOL EXECUTION ON COSMO (HTTP)
// ============================================================================

async function executeToolOnMaster(toolName, input) {
  const execStart = Date.now();
  await log("TOOL_EXEC_START", toolName + " Time:" + elapsed());
  await log("TOOL_EXEC_INPUT", JSON.stringify(input).substring(0, 500));

  try {
    // Add progress feedback for different tool types
    if (toolName === "exa_search") {
      await log("TOOL_PROGRESS", "initiating web search for: " + (input.query || "").substring(0, 100));
      if (input.numResults) {
        await log("TOOL_PROGRESS", "requesting " + input.numResults + " results");
      }
    } else if (toolName === "search_web") {
      await log("TOOL_PROGRESS", "searching web: " + (input.query || "").substring(0, 100));
    } else if (toolName.includes("gmail")) {
      await log("TOOL_PROGRESS", "connecting to Gmail API");
    } else if (toolName.includes("outlook")) {
      await log("TOOL_PROGRESS", "connecting to Outlook API");
    } else if (toolName.includes("phone")) {
      await log("TOOL_PROGRESS", "connecting to phone service");
    } else {
      await log("TOOL_PROGRESS", "executing " + toolName);
    }

    const response = await fetch(config.TOOL_EXEC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + config.TOOL_EXEC_SECRET
      },
      body: JSON.stringify({
        toolName,
        input,
        userId: config.USER_ID,
        isOwner: true,
        context: {
          timezone: config.TIMEZONE,
          ownerName: config.OWNER_NAME,
          assistantName: config.ASSISTANT_NAME,
          provisionedNumber: config.PROVISIONED_NUMBER,
          gmailAccounts: config.GMAIL_ACCOUNTS,
          outlookAccounts: config.OUTLOOK_ACCOUNTS,
          zoomAccounts: config.ZOOM_ACCOUNTS,
        }
      }),
      // Add 15 second timeout - tools should be fast (typically <2s)
      // If it takes longer than 15s, something is wrong
      signal: AbortSignal.timeout(15000)
    });
    
    await log("TOOL_PROGRESS", "received response, parsing data");
    
    let data;
    try {
      data = await response.json();
    } catch (jsonError) {
      // Handle corrupted JSON from timeout/partial response
      await log("TOOL_EXEC_ERROR", "JSON Parse error: " + jsonError.message);
      throw new Error("Failed to parse response JSON: " + jsonError.message);
    }
    
    // Add result size feedback
    const resultStr = JSON.stringify(data.result || data);
    if (resultStr.length > 10000) {
      await log("TOOL_PROGRESS", "processing large result (" + (resultStr.length / 1024).toFixed(1) + "KB)");
    }
    
    // Special feedback for search results
    if (toolName === "exa_search" && data.result) {
      try {
        // data.result may be object OR string depending on how cosmo returns it
        const parsed = typeof data.result === "string" ? JSON.parse(data.result) : data.result;
        if (parsed.results) {
          await log("TOOL_PROGRESS", "found " + parsed.results.length + " search results");
        }
      } catch (e) {
        // Ignore - just skip the progress log if parsing fails
      }
    }

    const duration = Date.now() - execStart;

    await log("TOOL_EXEC_RESULT", JSON.stringify(data.result || data).substring(0, 1000));
    await log("TOOL_EXEC_END", toolName + " DurationMs:" + duration + " Success:" + (data.success !== false));

    return data.result;
  } catch (err) {
    const duration = Date.now() - execStart;
    
    // Handle specific error types
    if (err.name === "TimeoutError" || err.message.includes("timeout") || err.message.includes("aborted")) {
      await log("TOOL_EXEC_ERROR", "HTTP timeout after " + (duration / 1000).toFixed(1) + "s");
    } else if (err.message.includes("JSON")) {
      await log("TOOL_EXEC_ERROR", "Response parsing failed: " + err.message);
    } else {
      await log("TOOL_EXEC_ERROR", err.message);
    }
    
    await log("TOOL_EXEC_END", toolName + " DurationMs:" + duration + " Success:false");
    throw err;
  }
}

// ============================================================================
// LOCAL TOOL DEFINITIONS
// These run in the container's /workspace directory
// ============================================================================

// Set of tools that are handled locally (not sent to Cosmo)
const LOCAL_TOOLS = new Set([
  "bash",
  "str_replace_based_edit_tool",
  "file_write",
  "file_read",
  "file_exists",
  "list_directory"
]);

async function executeLocalTool(toolName, input) {
  const execStart = Date.now();
  await log("LOCAL_TOOL_START", toolName + " Time:" + elapsed());

  try {
    let result;

    if (toolName === "bash") {
      const command = input.command;
      const restart = input.restart;
      
      if (restart) {
        await log("BASH", "(session restart requested)");
        result = "Bash session restarted";
      } else if (command) {
        await log("BASH", command.substring(0, 200));
        await log("TOOL_PROGRESS", "starting shell execution: " + command.split(" ")[0]);
        
        result = await new Promise((resolve) => {
          const proc = spawn("sh", ["-c", command], {
            cwd: "/workspace",
            env: { 
              ...process.env, 
              PATH: process.env.PATH + ":/root/.bun/bin",
              GH_TOKEN: config.GITHUB_TOKEN || "",
              GITHUB_TOKEN: config.GITHUB_TOKEN || "",
            }
          });
          
          let stdout = "";
          let stderr = "";
          let outputLineCount = 0;
          
          proc.stdout.on("data", async (data) => {
            const chunk = data.toString();
            stdout += chunk;
            outputLineCount += (chunk.match(/\n/g) || []).length;
            await log("BASH_STDOUT", chunk.substring(0, 200).replace(/\n/g, " | "));
            
            // Progress feedback for long outputs
            if (outputLineCount > 0 && outputLineCount % 50 === 0) {
              await log("TOOL_PROGRESS", "command output: " + outputLineCount + " lines");
            }
          });
          
          proc.stderr.on("data", async (data) => {
            const chunk = data.toString();
            stderr += chunk;
            await log("BASH_STDERR", chunk.substring(0, 200).replace(/\n/g, " | "));
          });
          
          const timeout = setTimeout(async () => {
            await log("TOOL_PROGRESS", "command timeout reached (5 minutes), terminating");
            proc.kill("SIGTERM");
            resolve("Error: Command timed out after 5 minutes");
          }, 300000);
          
          proc.on("close", async (code) => {
            clearTimeout(timeout);
            if (code === 0) {
              await log("TOOL_PROGRESS", "command completed successfully");
              resolve(stdout || "(no output)");
            } else {
              await log("TOOL_PROGRESS", "command failed with exit code " + code);
              resolve(stderr || stdout || "Command failed with exit code " + code);
            }
          });
          
          proc.on("error", async (err) => {
            clearTimeout(timeout);
            await log("TOOL_PROGRESS", "command error: " + err.message);
            resolve("Error: " + err.message);
          });
        });
        
        const exitCode = result.startsWith("Error:") || result.includes("exit code") ? "1" : "0";
        await log("BASH_RESULT", "ExitCode:" + exitCode);
      } else {
        result = "Error: No command provided";
      }
    } else if (toolName === "str_replace_based_edit_tool") {
      const cmd = input.command;
      const filePath = input.path?.startsWith("/") ? input.path : path.join("/workspace", input.path || "");

      await log("EDITOR_DEBUG", "Command:" + cmd + " Path:" + filePath + " InputKeys:" + Object.keys(input).join(","));
      
      if (cmd === "view") {
        await log("EDITOR", "view " + filePath);
        try {
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            await log("FILE_OP", "listing directory contents");
            const files = fs.readdirSync(filePath);
            result = files.join("\n");
          } else {
            await log("FILE_OP", "reading file (" + (stat.size / 1024).toFixed(1) + "KB)");
            const content = fs.readFileSync(filePath, "utf-8");
            const lines = content.split("\n");
            await log("FILE_OP", "processed " + lines.length + " lines");
            const numbered = lines.map((line, i) => (i + 1) + ": " + line);
            
            if (input.view_range) {
              const [start, end] = input.view_range;
              const endLine = end === -1 ? lines.length : end;
              await log("FILE_OP", "extracting lines " + start + "-" + endLine);
              result = numbered.slice(start - 1, endLine).join("\n");
            } else {
              result = numbered.join("\n");
            }
          }
        } catch (e) {
          result = "Error: " + e.message;
        }
      } else if (cmd === "str_replace") {
        await log("EDITOR", "str_replace in " + filePath);
        await log("EDITOR_DEBUG", "Replace - old_str:" + (input.old_str?.length || 0) + " new_str:" + (input.new_str?.length || 0) + " chars");
        try {
          await log("EDITOR_DEBUG", "Getting file stats");
          const stat = fs.statSync(filePath);
          await log("FILE_OP", "reading file for replacement (" + (stat.size / 1024).toFixed(1) + "KB)");
          await log("EDITOR_DEBUG", "Reading file content");
          const beforeContent = fs.readFileSync(filePath, "utf-8");
          await log("EDITOR_DEBUG", "File read completed - " + beforeContent.length + " chars");
          
          const oldStr = input.old_str;
          const newStr = input.new_str;
          
          await log("FILE_OP", "searching for target text (" + oldStr.length + " chars)");
          await log("EDITOR_DEBUG", "Starting split operation");
          const count = beforeContent.split(oldStr).length - 1;
          await log("EDITOR_DEBUG", "Split completed, found " + count + " matches");
          
          if (count === 0) {
            await log("FILE_OP", "no matches found");
            result = "Error: No match found for replacement text.";
          } else if (count > 1) {
            await log("FILE_OP", "found " + count + " matches (needs unique match)");
            result = "Error: Found " + count + " matches. Please provide more context for a unique match.";
          } else {
            await log("FILE_OP", "found 1 match, replacing text");
            await log("EDITOR_DEBUG", "Starting replace operation");
            const afterContent = beforeContent.replace(oldStr, newStr);
            await log("EDITOR_DEBUG", "Replace completed - new size:" + afterContent.length + " chars");
            await log("FILE_OP", "writing updated content (" + (afterContent.length / 1024).toFixed(1) + "KB)");
            await log("EDITOR_DEBUG", "About to write file");
            fs.writeFileSync(filePath, afterContent);
            await log("EDITOR_DEBUG", "File write completed");
            result = "Successfully replaced text at exactly one location.";
            await log("FILE_EDIT_RESULT", "Path:" + filePath + " Success:true");
          }
        } catch (e) {
          await log("EDITOR_ERROR", "Replace failed: " + e.message + " OldStr:" + (input.old_str?.length || 0) + " NewStr:" + (input.new_str?.length || 0));
          result = "Error: " + e.message;
        }
      } else if (cmd === "create") {
        await log("EDITOR", "create " + filePath);
        await log("EDITOR_DEBUG", "Create - file_text length:" + (input.file_text?.length || 0) + " chars");
        try {
          const dir = path.dirname(filePath);
          await log("EDITOR_DEBUG", "Creating directory: " + dir);
          await log("FILE_OP", "creating directories: " + dir);
          fs.mkdirSync(dir, { recursive: true });
          await log("EDITOR_DEBUG", "Directory created successfully");
          
          const fileContent = input.file_text || "";
          await log("EDITOR_DEBUG", "About to write file - size:" + fileContent.length + " chars (" + (fileContent.length / 1024).toFixed(1) + "KB)");
          await log("FILE_OP", "writing new file (" + (fileContent.length / 1024).toFixed(1) + "KB)");
          
          // For very large files, log progress
          if (fileContent.length > 100000) {
            await log("EDITOR_DEBUG", "Large file detected - writing in chunks");
          }
          
          fs.writeFileSync(filePath, fileContent);
          await log("EDITOR_DEBUG", "File write completed successfully");
          
          // Verify the file was written
          const writtenSize = fs.statSync(filePath).size;
          await log("EDITOR_DEBUG", "Verified written file size: " + writtenSize + " bytes");
          
          result = "File created successfully.";
          await log("FILE_EDIT_RESULT", "Path:" + filePath + " Success:true");
        } catch (e) {
          await log("EDITOR_ERROR", "Create failed: " + e.message + " FileSize:" + (input.file_text?.length || 0));
          result = "Error: " + e.message;
        }
      } else if (cmd === "insert") {
        await log("EDITOR", "insert in " + filePath);
        await log("EDITOR_DEBUG", "Insert - line:" + (input.insert_line || 0) + " text:" + (input.new_str?.length || 0) + " chars");
        try {
          await log("EDITOR_DEBUG", "Reading file for insert");
          const content = fs.readFileSync(filePath, "utf-8");
          await log("EDITOR_DEBUG", "File read - splitting into lines");
          const lines = content.split("\n");
          const insertLine = input.insert_line || 0;
          const insertText = input.new_str || "";
          await log("EDITOR_DEBUG", "Inserting at line " + insertLine + " of " + lines.length + " total lines");
          lines.splice(insertLine, 0, insertText);
          await log("EDITOR_DEBUG", "Insert completed - writing file");
          fs.writeFileSync(filePath, lines.join("\n"));
          await log("EDITOR_DEBUG", "Insert write completed");
          result = "Successfully inserted text.";
          await log("FILE_EDIT_RESULT", "Path:" + filePath + " Success:true");
        } catch (e) {
          await log("EDITOR_ERROR", "Insert failed: " + e.message + " Line:" + (input.insert_line || 0));
          result = "Error: " + e.message;
        }
      } else {
        result = "Error: Unknown editor command: " + cmd;
      }
    } else if (toolName === "file_write") {
      // Write content to file (supports base64 for binary)
      const filePath = input.path?.startsWith("/") ? input.path : "/workspace/" + input.path;
      const content = input.content || "";
      const encoding = input.encoding || "utf-8";
      
      await log("FILE_WRITE", filePath + " encoding:" + encoding);
      try {
        const dir = path.dirname(filePath);
        await log("FILE_OP", "creating directories: " + dir);
        fs.mkdirSync(dir, { recursive: true });
        
        if (encoding === "base64") {
          await log("FILE_OP", "decoding base64 content (" + content.length + " chars)");
          const buffer = Buffer.from(content, "base64");
          await log("FILE_OP", "writing binary file (" + (buffer.length / 1024).toFixed(1) + "KB)");
          fs.writeFileSync(filePath, buffer);
          result = JSON.stringify({ success: true, path: filePath, size: buffer.length, encoding: "base64" });
        } else {
          await log("FILE_OP", "writing text file (" + (content.length / 1024).toFixed(1) + "KB)");
          fs.writeFileSync(filePath, content, "utf-8");
          result = JSON.stringify({ success: true, path: filePath, size: content.length, encoding: "utf-8" });
        }
        await log("FILE_WRITE_RESULT", "Path:" + filePath + " Success:true");
      } catch (e) {
        result = JSON.stringify({ success: false, error: e.message });
        await log("FILE_WRITE_RESULT", "Path:" + filePath + " Success:false Error:" + e.message);
      }
    } else if (toolName === "file_read") {
      // Read file content (supports base64 for binary/attachments)
      const filePath = input.path?.startsWith("/") ? input.path : "/workspace/" + input.path;
      const encoding = input.encoding || "utf-8";
      
      await log("FILE_READ", filePath + " encoding:" + encoding);
      try {
        const stat = fs.statSync(filePath);
        await log("FILE_OP", "reading file (" + (stat.size / 1024).toFixed(1) + "KB)");
        
        if (encoding === "base64") {
          const buffer = fs.readFileSync(filePath);
          await log("FILE_OP", "encoding to base64 (" + buffer.length + " bytes)");
          result = JSON.stringify({ success: true, path: filePath, content: buffer.toString("base64"), size: buffer.length, encoding: "base64" });
        } else {
          const content = fs.readFileSync(filePath, "utf-8");
          await log("FILE_OP", "loaded " + content.split("\n").length + " lines");
          result = JSON.stringify({ success: true, path: filePath, content, size: content.length, encoding: "utf-8" });
        }
        await log("FILE_READ_RESULT", "Path:" + filePath + " Success:true");
      } catch (e) {
        result = JSON.stringify({ success: false, error: e.message });
        await log("FILE_READ_RESULT", "Path:" + filePath + " Success:false Error:" + e.message);
      }
    } else if (toolName === "file_exists") {
      const filePath = input.path?.startsWith("/") ? input.path : "/workspace/" + input.path;
      await log("FILE_OP", "checking existence: " + filePath);
      try {
        const stat = fs.statSync(filePath);
        const fileType = stat.isDirectory() ? "directory" : "file";
        await log("FILE_OP", "found " + fileType + " (" + (stat.size / 1024).toFixed(1) + "KB)");
        result = JSON.stringify({
          exists: true,
          type: fileType,
          size: stat.size
        });
      } catch (e) {
        await log("FILE_OP", "not found");
        result = JSON.stringify({ exists: false });
      }
    } else if (toolName === "list_directory") {
      const dirPath = input.path?.startsWith("/") ? input.path : "/workspace/" + (input.path || "");
      await log("FILE_OP", "list " + dirPath);
      
      const listDir = (dir, recursive) => {
        const entries = [];
        try {
          // Note: Can't use await log() here - function is not async
          const items = fs.readdirSync(dir, { withFileTypes: true });
          
          for (const item of items) {
            const fullPath = path.join(dir, item.name);
            const entry = {
              name: item.name,
              type: item.isDirectory() ? "directory" : "file",
              path: fullPath.replace("/workspace/", "")
            };
            if (!item.isDirectory()) {
              try { entry.size = fs.statSync(fullPath).size; } catch {}
            }
            entries.push(entry);
            if (recursive && item.isDirectory()) {
              entries.push(...listDir(fullPath, true));
            }
          }
        } catch (e) {
          return [{ error: e.message }];
        }
        return entries;
      };

      const entries = listDir(dirPath, input.recursive || false);
      await log("FILE_OP", "completed listing: " + entries.length + " total entries");
      result = JSON.stringify(entries, null, 2);
    } else {
      result = { success: false, error: "Unknown local tool: " + toolName };
    }

    const duration = Date.now() - execStart;
    await log("EDITOR_DEBUG", "Tool completed - result length:" + (typeof result === "string" ? result.length : "non-string"));
    await log("LOCAL_TOOL_END", toolName + " DurationMs:" + duration);
    await log("EDITOR_DEBUG", "Returning result to Anthropic");
    return result;
  } catch (err) {
    const duration = Date.now() - execStart;
    await log("LOCAL_TOOL_ERROR", toolName + " " + err.message);
    throw err;
  }
}

// ============================================================================
// TASK COMPLETION
// ============================================================================

async function markComplete(result, tokenUsage?) {
  await log("SANDBOX_DONE", "Success:true DurationMs:" + elapsed());
  await new Promise(r => setTimeout(r, 100));
  closeLogSocket();
  if (config.CALLBACK_URL) {
    await fetch(config.CALLBACK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + config.TASK_CALLBACK_SECRET
      },
      body: JSON.stringify({ 
        success: true, 
        result,
        userId: config.USER_ID,
        taskName: config.TASK_NAME,
        tokenUsage  // Include token usage for billing
      })
    }).catch((e) => console.error("Callback failed:", e.message));
  }
  process.exit(0);
}

async function markFailed(error, tokenUsage?) {
  await log("SANDBOX_DONE", "Success:false DurationMs:" + elapsed() + " Error:" + error);
  await new Promise(r => setTimeout(r, 100));
  closeLogSocket();
  if (config.CALLBACK_URL) {
    await fetch(config.CALLBACK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + config.TASK_CALLBACK_SECRET
      },
      body: JSON.stringify({ 
        success: false, 
        error,
        userId: config.USER_ID,
        taskName: config.TASK_NAME,
        tokenUsage  // Include token usage for billing
      })
    }).catch((e) => console.error("Callback failed:", e.message));
  }
  process.exit(1);
}

// ============================================================================
// CONTEXT COMPACTION (Emergency recovery when context too large)
// ============================================================================

const COMPACTION_SUMMARY_PROMPT = `You have been working on a task but have not completed it yet.
Write a CONCISE continuation summary (under 2000 tokens) to resume efficiently.

Include:
1. TASK: What the user asked for (1-2 sentences)
2. DONE: What you've completed so far (bullet points)
3. FILES: Any files created/modified in /workspace
4. RESULTS: Key findings from searches/tools (condensed)
5. NEXT: Specific remaining steps to complete the task

Be extremely concise. This summary replaces the entire conversation history.
Do NOT include raw data, code, or verbose content - just the essentials.`;

async function compactConversation(client, currentMessages, model, logFn) {
  await logFn("COMPACTION_START", "Messages:" + currentMessages.length);
  
  // Clean messages - remove trailing tool_use blocks (would cause API error)
  const cleanedMessages = JSON.parse(JSON.stringify(currentMessages));
  const lastMsg = cleanedMessages[cleanedMessages.length - 1];
  
  if (lastMsg?.role === "assistant" && Array.isArray(lastMsg.content)) {
    const nonToolBlocks = lastMsg.content.filter(b => b.type !== "tool_use");
    if (nonToolBlocks.length === 0) {
      cleanedMessages.pop();
    } else {
      lastMsg.content = nonToolBlocks;
    }
  }
  
  // Also remove any dangling tool_result without matching tool_use
  while (cleanedMessages.length > 0) {
    const last = cleanedMessages[cleanedMessages.length - 1];
    if (last?.role === "user" && Array.isArray(last.content) && 
        last.content.every(b => b.type === "tool_result")) {
      cleanedMessages.pop();
    } else {
      break;
    }
  }
  
  try {
    const summaryResponse = await client.messages.create({
      model,
      max_tokens: 4000,
      messages: [
        ...cleanedMessages,
        { role: "user", content: COMPACTION_SUMMARY_PROMPT }
      ]
    });
    
    const summaryText = summaryResponse.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n");
    
    await logFn("COMPACTION_DONE", "SummaryLength:" + summaryText.length);
    
    // Return new messages array with just the summary
    return [{
      role: "user",
      content: "[CONTEXT COMPACTED - Previous conversation summarized]\n\n" + summaryText +
               "\n\n[Continue from where you left off. Complete the remaining steps.]"
    }];
  } catch (compactError) {
    await logFn("COMPACTION_FAILED", compactError.message);
    throw compactError;
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  await log("SANDBOX_START", "Time:0");
  await log("SANDBOX_INFO", "Model:" + (config.MODEL || "claude-sonnet-4-5-20250929"));
  await log("SANDBOX_INFO", "Instructions:" + JSON.stringify(config.TASK_INSTRUCTIONS?.substring(0, 100)));
  
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  
  // === TOOL CALLING MODE ===
  // hybrid = both direct and code_execution (Claude chooses)
  function getCallers(mode) {
    if (mode === "direct") return ["direct"];
    if (mode === "code_execution") return ["code_execution_20250825"];
    return ["code_execution_20250825", "direct"]; // hybrid
  }
  const localAllowedCallers = getCallers(config.LOCAL_TOOLS_MODE || "hybrid");
  const remoteAllowedCallers = getCallers(config.TOOL_CALLING_MODE || "hybrid");
  
  await log("PTC_MODE", "Local:" + (config.LOCAL_TOOLS_MODE || "hybrid") + " Remote:" + (config.TOOL_CALLING_MODE || "hybrid"));
  
  // === LOCAL TOOLS (run in container) - NON-DEFERRED ===
  const localTools = [
    {
      name: "bash",
      description: "Execute shell commands in YOUR CONTAINER's /workspace directory. Full Linux environment: git, npm, pip, gh CLI, wkhtmltopdf (HTML→PDF), pandoc (markdown→PDF/HTML), imagemagick (image processing). Files created here are accessible to other tools. Returns stdout/stderr. Use for: installing packages, creating PDFs, git operations, file processing.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute (runs in /workspace)" },
          restart: { type: "boolean", description: "Restart bash session (optional)" }
        },
        required: ["command"]
      },
      allowed_callers: localAllowedCallers,
      defer_loading: false
    },
    {
      name: "str_replace_based_edit_tool",
      description: "View, create, and edit files in /workspace. Commands: view, str_replace, create, insert.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", enum: ["view", "str_replace", "create", "insert"] },
          path: { type: "string", description: "File path (relative to /workspace)" },
          view_range: { type: "array", items: { type: "integer" }, description: "[start, end] lines" },
          old_str: { type: "string", description: "Text to replace" },
          new_str: { type: "string", description: "New text" },
          file_text: { type: "string", description: "Content for new file" },
          insert_line: { type: "integer", description: "Line number to insert after" }
        },
        required: ["command", "path"]
      },
      allowed_callers: localAllowedCallers,
      defer_loading: false
    },
    {
      name: "file_write",
      description: "Write content to a file in /workspace. Supports text (utf-8) or binary (base64). Returns JSON: {success, path, size, encoding}. Use for reports, HTML, CSV, binary files.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to /workspace" },
          content: { type: "string", description: "File content (text or base64-encoded for binary)" },
          encoding: { type: "string", enum: ["utf-8", "base64"], description: "Content encoding (default: utf-8)" }
        },
        required: ["path", "content"]
      },
      allowed_callers: localAllowedCallers,
      defer_loading: false
    },
    {
      name: "file_read",
      description: "Read file content. Returns JSON: {success, content, ...}. For EMAIL ATTACHMENTS: use encoding='base64' and pass the returned 'content' field directly to gmail_draftEmail attachments - NO Python base64 encoding needed!",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to /workspace" },
          encoding: { type: "string", enum: ["utf-8", "base64"], description: "Use 'base64' for email attachments!" }
        },
        required: ["path"]
      },
      allowed_callers: localAllowedCallers,
      defer_loading: false
    },
    {
      name: "file_exists",
      description: "Check if file/directory exists. Returns JSON: {exists, type, size}.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to check" }
        },
        required: ["path"]
      },
      allowed_callers: localAllowedCallers,
      defer_loading: false
    },
    {
      name: "list_directory",
      description: "List directory contents. Returns JSON array of {name, type, size, path}.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path" },
          recursive: { type: "boolean", description: "Include subdirectories" }
        },
        required: []
      },
      allowed_callers: localAllowedCallers,
      defer_loading: false
    }
  ];
  
  // === BUILD FULL TOOLS ARRAY ===
  const tools = [
    // Anthropic's built-in tools
    { type: "code_execution_20250825", name: "code_execution" },
    { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" },
    // Local tools (NON-DEFERRED)
    ...localTools,
    // Remote tools from Cosmo (DEFERRED via tool_search)
    ...(config.TOOL_SCHEMAS || []).map(tool => ({
      name: tool.name,
      description: tool.description || tool.name,
      input_schema: tool.parameters || { type: "object", properties: {} },
      allowed_callers: remoteAllowedCallers,
      defer_loading: config.ENABLE_TOOL_SEARCH !== false
    }))
  ];
  
  await log("SANDBOX_INFO", "Tools:" + tools.length + " (local:" + localTools.length + ", remote:" + (config.TOOL_SCHEMAS?.length || 0) + ")");
  
  // === SYSTEM PROMPT BUILDER ===
  
function buildSystemPrompt(config) {
  let prompt = `You are ${config.ASSISTANT_NAME}, ${config.OWNER_NAME}'s personal AI assistant running in a Linux sandbox with full filesystem access.
Use tool_search_tool_bm25 to discover available tools.

# Tool Calling Strategy
You can call tools in TWO ways:

**1. DIRECT (DEFAULT):** Call tools directly as tool_use blocks.
   - USE FOR: Most tasks, file operations, single/sequential tool calls
   - ALL file operations MUST use direct tools (bash, file_write, str_replace_based_edit_tool)
   - Faster and simpler - no Python overhead

**2. code_execution (for parallel orchestration):** Write Python code.
   - USE FOR: Calling 3+ tools simultaneously with asyncio.gather()
   - USE FOR: Complex tool orchestration, loops over API calls
   - ONLY for calling OTHER tools - NOT for creating deliverable files!
   - After code_execution finishes, use DIRECT tools for any file operations
   - IMPORTANT: Local tools (bash, file_read, file_write) work INSIDE code_execution!
   - They access YOUR CONTAINER's /workspace even when called from Python code

## CRITICAL: Two-Container Architecture

**YOUR CONTAINER** (persistent /workspace):
- File tools (bash, file_write, str_replace_based_edit_tool) create files HERE
- Files in /workspace persist and can be emailed/used
- THIS is where all deliverable files must be created

**ANTHROPIC CONTAINER** (ephemeral /tmp):
- code_execution runs here in isolated Python environment
- Any files created with Python open() go to /tmp and are LOST when code finishes
- CANNOT access files in /tmp from your container tools
- BUT it CAN call your local tools: file_read/file_write/list_directory/bash via tool calls
- file_read from code_execution reads YOUR /workspace and returns content into code_execution context

## Container Paths & Reuse
- code_execution /tmp is separate; NEVER try to read /tmp with bash (bash runs in YOUR /workspace).
- If you create files in /tmp, reuse them in another code_execution call (same container persists via containerId).
- To share data with /workspace, read the /tmp file inside code_execution and call file_write tool to /workspace.
- Prefer writing directly to /workspace using file_write/str_replace_based_edit_tool to avoid /tmp confusion. file_read works in code_execution. It runs in your container but results are returned to code_execution context if called from code_execution.

## Workflow Examples

**Example 1: AI Research Report**
WRONG: Use code_execution for both search AND PDF creation ❌
results = await asyncio.gather(exa_search(...), exa_search(...))
with open('report.pdf', 'wb') as f:  # Goes to /tmp, LOST when code finishes!

RIGHT: Use code_execution for search, DIRECT tools for file creation ✅
Step 1: code_execution to gather data in parallel
  results = await asyncio.gather(exa_search(...), exa_search(...), exa_search(...))
  print(json.dumps(results))  # Return to context
Step 2: Use DIRECT tools to create file in /workspace
  bash(command='wkhtmltopdf report.html report.pdf')  # Creates in /workspace

**Example 2: Send Email with Attachment**
CRITICAL: Local tools (file_read, bash, etc.) work INSIDE code_execution!
They access YOUR CONTAINER's /workspace even when called from code_execution.

RIGHT: Call file_read INSIDE code_execution, use result directly ✅
  async def send_report():
      file_data = await file_read({'path': '/workspace/report.html', 'encoding': 'base64'})
      result = json.loads(file_data)
      await gmail_sendEmail({
          'to': ['user@example.com'],
          'attachments': [{'filename': 'report.html', 'content': result['content']}]
      })

WRONG: Read file, then hardcode the base64 string ❌
  content = "PCFET0NUWVBFIGh0bWw+..."  # ❌ Never hardcode base64!

**DECISION TREE:**
- Need to call 3+ tools in parallel? → code_execution
- Need to create/modify files? → DIRECT tools (bash/file_write/str_replace)
- Need to email a file? → code_execution (file_read + gmail_sendEmail together)
- Simple 1-2 tool sequence? → DIRECT tools

**CRITICAL: Local tools (bash, file_read, file_write) work in code_execution!**
They access YOUR CONTAINER's /workspace even when called from Python code.
NEVER manually generate base64/JSON - always use tool results directly!

**If code_execution fails:** First fix/retry in code_execution (bad code, missing imports, etc.). If it’s an Anthropic/infra error, retry once; only then fall back to direct tools.

# One-Shot Example (single code_execution, hybrid tools)
- In one code_execution you can:
  1) exa_search news
  2) build HTML string in Python
  3) file_write to /workspace/ai_news_report.html
  4) call bash tool to run: wkhtmltopdf --enable-local-file-access /workspace/ai_news_report.html /workspace/ai_news_report.pdf
  5) file_read both files with encoding='base64'
  6) gmail_sendEmail with attachments using the content fields
- NOTE: bash runs in YOUR /workspace, so wkhtmltopdf works when invoked via bash from code_execution.

# Sandbox Environment (Linux Container)
You have FULL FILESYSTEM ACCESS in /workspace with these LOCAL tools:
- bash: Execute ANY shell command (git, npm, pip, gh CLI, etc.)
- str_replace_based_edit_tool: View, create, edit files
- file_write: Write files (supports encoding='base64' for binary)
- file_read: Read files (returns base64 when encoding='base64')
- file_exists: Check if file/directory exists
- list_directory: List directory contents

## Installed CLI/Python in YOUR CONTAINER (/workspace) — use via bash (NOT importable in Anthropic Python)
- pandoc (format conversion: md/html ↔ pdf/docx/…)
- wkhtmltopdf (HTML→PDF fallback) · imagemagick (images)
- Python libs (call with bash python -c "..." or write a .py and run with bash): weasyprint (HTML/CSS→PDF), pandas+openpyxl (Excel/CSV),
  pillow (images), matplotlib (charts), requests, beautifulsoup4+lxml (HTML parse),
  python-docx / python-pptx, jinja2, pyyaml, python-dateutil+pytz, qrcode
- IMPORTANT: These are ONLY in YOUR CONTAINER. The Anthropic code_execution container cannot import them directly; if needed from code_execution, invoke bash tool to run Python/CLIs in /workspace.
- Container is ephemeral: write scripts/files under /workspace before running them.

## Tool Return Parsing (file_read)
- file_read returns a JSON string: {"success":true,"content":"BASE64..."}
- In code_execution you'll get a string; parse with json.loads(result)
- If it looks double-escaped (starts with "\{" or has many backslashes), parse twice: data = json.loads(json.loads(result))
- Use data["content"] directly for attachments; NEVER base64-encode again

## Email: When to SEND vs DRAFT

**USE gmail_sendEmail (send directly) when:**
- Owner says 'send to my email', 'email it to me', 'send me'
- Direct task results going to OWNER's own email (news, reports, summaries)
- Owner explicitly uses 'send' not 'draft'

**USE gmail_draftEmail (draft first) when:**
- Emailing SOMEONE ELSE (not the owner)
- Important/sensitive content that needs review
- Owner says 'draft', 'compose', or 'prepare'
- Any uncertainty about content or recipient

## Email Attachments Workflow
1. Create file: str_replace_based_edit_tool(command='create', path='/workspace/file.html', file_text='...')
2. Read as base64: file_read(path='/workspace/file.html', encoding='base64')
   → Returns: {success: true, content: 'BASE64_STRING_HERE', ...}
3. Send/Draft email with attachment: attachments: [{content: THE_CONTENT_FROM_STEP_2, ...}]

**NEVER use Python/bash to encode or parse! The file_read content IS the base64 string - use it DIRECTLY!**

Working directory: /workspace`;

  if (config.GITHUB_TOKEN) {
    prompt += `

# GitHub Access
You have FULL GitHub access via git and gh CLI.
- git clone/push/pull - credentials pre-configured
- gh repo create --public/--private - create repos
- gh pr create/list/merge - pull requests
- gh issue create/list/close - issues

**When done building:** Create a GitHub repo and push the code!`;
  }

  prompt += `

# Current Date & Time
${config.CURRENT_DATE_TIME || new Date().toISOString()}
Timezone: ${config.TIMEZONE}

# Identity
- You are: ${config.ASSISTANT_NAME} (${config.OWNER_NAME}'s AI assistant)`;
  
  if (config.PROVISIONED_NUMBER) {
    prompt += `
- Your phone number: ${config.PROVISIONED_NUMBER}`;
  }
  
  prompt += `
- Owner: ${config.OWNER_NAME}
- Owner phone: ${config.OWNER_PHONE || "not provided"}`;

  if (config.GMAIL_ACCOUNTS?.length) {
    prompt += `

# Connected Google Accounts`;
    config.GMAIL_ACCOUNTS.forEach(acc => {
      prompt += `\n- ${acc.email} (${acc.label})`;
    });
  }

  if (config.OUTLOOK_ACCOUNTS?.length) {
    prompt += `

# Connected Microsoft Accounts`;
    config.OUTLOOK_ACCOUNTS.forEach(acc => {
      prompt += `\n- ${acc.email} (${acc.label})`;
    });
  }

  if (config.ZOOM_ACCOUNTS?.length) {
    prompt += `

# Connected Zoom Accounts`;
    config.ZOOM_ACCOUNTS.forEach(acc => {
      prompt += `\n- ${acc.email} (${acc.label})`;
    });
  }

  if (config.BOSS_GENERAL_CONTEXT) {
    prompt += `

# About ${config.OWNER_NAME}
${config.BOSS_GENERAL_CONTEXT}`;
  }

  if (config.BOSS_WEEKLY_CONTEXT) {
    prompt += `

# This Week
${config.BOSS_WEEKLY_CONTEXT}`;
  }

  if (config.CALLER_CONTEXT && !config.CALLER_CONTEXT.isOwner) {
    prompt += `

# IMPORTANT: Caller Context
You are NOT speaking with ${config.OWNER_NAME}. You are speaking with: ${config.CALLER_CONTEXT.contactName || "Unknown contact"}
Permission tier: ${config.CALLER_CONTEXT.permissionTier || "contact"}`;
  } else {
    prompt += `

**Critical:** When instructions say 'send to me' or 'send to owner' - this is the owner (phone: ${config.OWNER_PHONE || "search contacts"}).`;
  }

  prompt += `

# Task Completion

**IMPORTANT:** Your final response will be sent directly to the user via SMS.
- Make it clear, concise, and helpful`;
  
  if (config.GITHUB_TOKEN) {
    prompt += `
- Include the GitHub repo URL prominently`;
  }
  
  prompt += `
- You do NOT have SMS tools - the system handles notification automatically
- Do NOT try to call any sms_send tool - just write your final summary`;

  return prompt;
}

  
  // === SYSTEM PROMPT ===
  const systemPrompt = buildSystemPrompt(config);
  
  let messages = [{ role: "user", content: "Task: " + config.TASK_INSTRUCTIONS }];
  let iteration = 0;
  let emptyIterations = 0;
  let containerId: string | undefined;  // Track Anthropic's code execution container
  let loggedToolSearchResults = new Set<string>();  // Dedupe tool search logs (Anthropic re-sends them)
  
  // Track cumulative token usage for billing
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  
  await log("MODE", "streaming=" + config.STREAMING + " thinking=" + config.THINKING);
  
  while (iteration < config.MAX_ITERATIONS) {
    iteration++;
    const iterStart = Date.now();
    await log("ITER_START", iteration + " Time:" + elapsed());
    await log("EDITOR_DEBUG", "Starting iteration " + iteration + " - messages array has " + messages.length + " entries");
    
    try {
      const useStreaming = config.STREAMING !== false;
      await log("ITER_MODE", "Streaming:" + useStreaming + " Thinking:" + (config.THINKING !== false));
      
      // TEMP: disabled context-management - crashes on long code_execution
      const betas = ["advanced-tool-use-2025-11-20", "prompt-caching-2024-07-31"];
      if (config.THINKING !== false) {
        betas.push("interleaved-thinking-2025-05-14");
      }
      
      // System prompt with cache_control for prompt caching
      // This caches the static system prompt to save tokens on subsequent calls
      const systemWithCache = [{
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" }
      }];
      
      const requestOptions: any = {
        model: config.MODEL || "claude-sonnet-4-5-20250929",
        betas,
        max_tokens: 16384,
        system: systemWithCache,
        messages,
        tools,
        // TEMP: disabled context_management - crashes on long code_execution
        /*
        context_management: {
          edits: [
            {
              type: "clear_thinking_20251015",
              keep: { type: "thinking_turns", value: 3 }
            },
            {
              type: "clear_tool_uses_20250919",
              trigger: { type: "input_tokens", value: 180000 },
              keep: { type: "tool_uses", value: 15 },
              clear_at_least: { type: "input_tokens", value: 10000 },
              exclude_tools: ["tool_search_tool_bm25"],
              clear_tool_inputs: false
            }
          ]
        }
        */
      };
      
      // Pass container ID to resume code execution (CRITICAL for programmatic tool calling)
      if (containerId) {
        requestOptions.container = containerId;
        await log("CONTAINER_REUSE", containerId);
      }
      
      if (config.THINKING !== false) {
        requestOptions.thinking = { type: "enabled", budget_tokens: config.THINKING_BUDGET || 10000 };
      }
      
      let response;
      let hasThinking = false;
      let hasText = false;
      let hasCodeInput = false;
      
      if (useStreaming) {
        await log("API_STREAM_START", "Beginning streaming request...");
        const stream = client.beta.messages.stream(requestOptions);
        
        let currentBlockType = "";
        let currentBlockName = "";  // Track block name for distinguishing tool_search from code_execution
        let currentThinking = "";
        let currentText = "";
        let currentInput = "";
        let lastThinkingLog = 0;
        let eventCount = 0;
        let blockStartTime = Date.now();
        
        for await (const event of stream) {
          eventCount++;
          
          if (event.type === "content_block_start") {
            const block = event.content_block;
            currentBlockType = block.type;
            currentBlockName = block.name || "";  // Track name for tool_search vs code_execution
            blockStartTime = Date.now();
            currentInput = "";
            
            // Debug: log all block types to help troubleshoot
            await log("BLOCK_START", "type:" + block.type + " name:" + (block.name || "-"));
            
            if (block.type === "thinking") {
              currentThinking = "";
              lastThinkingLog = 0;
            } else if (block.type === "text") {
              currentText = "";
            } else if (block.type === "tool_use") {
              await log("TOOL_USE", "Calling: " + block.name + " id:" + block.id);
            // Tool search - check BOTH SDK types and API types
            // NOTE: Query comes via input_json_delta, so we'll log it at content_block_stop
            } else if (block.type === "tool_search_tool_use") {
              // SDK-specific type for tool search - query will be logged at block_stop
              await log("TOOL_SEARCH_START", "SDK type tool_search_tool_use");
            } else if (block.type === "server_tool_use" && 
                       (block.name === "tool_search_tool_bm25" || block.name === "tool_search_tool_regex")) {
              // API type: server_tool_use with tool_search name - query will be logged at block_stop
              await log("TOOL_SEARCH_START", "API type server_tool_use name:" + block.name);
            } else if (block.type === "server_tool_use" || block.type === "code_execution_tool_use") {
              // Code execution (not tool search)
              await log("CODE_EXEC_START", "Claude is writing code...");
            // Tool search result - check BOTH formats (dedupe because Anthropic re-sends in continuations)
            } else if (block.type === "tool_search_tool_result") {
              // SDK-specific type for tool search result
              const refs = block.content?.tool_references || block.content || [];
              const names = Array.isArray(refs) ? refs.map(r => r.tool_name).join(", ") : "";
              if (!loggedToolSearchResults.has(names)) {
                loggedToolSearchResults.add(names);
                await log("TOOL_SEARCH_RESULT", "Found: " + (names || "(none)"));
              }
            } else if (block.type === "tool_result" && block.content?.[0]?.type === "tool_reference") {
              // API type: tool_result containing tool_reference
              const refs = block.content || [];
              const names = refs.filter(r => r.type === "tool_reference").map(r => r.tool_name).join(", ");
              if (!loggedToolSearchResults.has(names)) {
                loggedToolSearchResults.add(names);
                await log("TOOL_SEARCH_RESULT", "Found: " + (names || "(none)"));
              }
            } else if (block.type === "code_execution_tool_result" || block.type === "code_execution_result" || block.type === "bash_code_execution_tool_result") {
              // Check if it's an error response from Anthropic
              if (block.content?.type === "code_execution_tool_result_error") {
                await log("CODE_EXEC_ERROR", "Anthropic code execution unavailable: " + (block.content.error_code || "unknown"));
              } else {
                // Normal success case
                const stdout = block.content?.stdout || block.stdout || "";
                const returnCode = block.content?.return_code ?? block.return_code ?? 0;
                const stderr = block.content?.stderr || block.stderr || "";
                await log("CODE_EXEC_RESULT", "ReturnCode:" + returnCode + " Stdout:" + (stdout ? String(stdout).substring(0, 500).replace(/\n/g, " | ") : "(empty)"));
                if (stderr) {
                  await log("CODE_EXEC_STDERR", stderr.substring(0, 500).replace(/\n/g, " | "));
                }
              }
            }
          }
          
          else if (event.type === "content_block_delta") {
            const delta = event.delta;
            
            if (delta.type === "thinking_delta") {
              currentThinking += delta.thinking || "";
              const newContent = currentThinking.substring(lastThinkingLog);
              if (newContent.length >= 100) {
                await log("THINKING_CHUNK", newContent.replace(/\n/g, " "));
                lastThinkingLog = currentThinking.length;
              }
              hasThinking = true;
            } else if (delta.type === "text_delta") {
              currentText += delta.text || "";
              await log("TEXT_CHUNK", (delta.text || "").replace(/\n/g, " ¶ "));
              hasText = true;
            } else if (delta.type === "input_json_delta") {
              currentInput += delta.partial_json || "";
              hasCodeInput = true;
            }
          }
          
          else if (event.type === "content_block_stop") {
            const duration = Date.now() - blockStartTime;
            
            if (currentThinking) {
              const remaining = currentThinking.substring(lastThinkingLog);
              if (remaining) {
                await log("THINKING_CHUNK", remaining.replace(/\n/g, " "));
              }
              await log("THINKING_DONE", "Thought for " + (duration / 1000).toFixed(1) + "s");
              currentThinking = "";
              lastThinkingLog = 0;
            }
            
            if (currentText) {
              currentText = "";
            }
            
            // Check if this was a tool_search block
            const isToolSearch = currentBlockType === "tool_search_tool_use" ||
                                 currentBlockName === "tool_search_tool_bm25" || 
                                 currentBlockName === "tool_search_tool_regex";
            
            // For tool_search, extract and log the query from accumulated input
            if (isToolSearch) {
              if (currentInput) {
                try {
                  const parsed = JSON.parse(currentInput);
                  const query = parsed.query || parsed.queries?.[0] || "(no query in input)";
                  await log("TOOL_SEARCH_QUERY", query);
                } catch (e) {
                  await log("TOOL_SEARCH_QUERY", "(parse error: " + e.message + ")");
                }
              } else {
                await log("TOOL_SEARCH_QUERY", "(no input accumulated)");
              }
              currentInput = "";
            }
            // Parse code from server_tool_use/code_execution_tool_use, but NOT from tool_search
            else if (currentInput && (currentBlockType === "server_tool_use" || currentBlockType === "code_execution_tool_use")) {
              try {
                const parsed = JSON.parse(currentInput);
                if (parsed.code) {
                  await log("CODE_LANG", parsed.language || "python");
                  const lines = parsed.code.split("\n");
                  for (const line of lines) {
                    await log("CODE", line);
                  }
                }
              } catch {}
              currentInput = "";
            }
            
            currentBlockType = "";
            currentBlockName = "";
          }
          
          else if (event.type === "message_delta") {
            if (event.delta?.stop_reason) {
              await log("ITER_STOP", "Reason:" + event.delta.stop_reason);
            }
          }
        }
        
        response = await stream.finalMessage();
        await log("API_STREAM_END", "Events:" + eventCount + " Blocks:" + response.content?.length);
        
        // Extract container ID for programmatic tool calling
        if (response.container?.id) {
          containerId = response.container.id;
          await log("CONTAINER_ID", containerId + " expires:" + response.container.expires_at);
        }
        
        if (response.context_management?.applied_edits?.length) {
          for (const edit of response.context_management.applied_edits) {
            if (edit.type === "clear_tool_uses_20250919") {
              await log("CONTEXT_CLEARED", "ToolUses:" + edit.cleared_tool_uses + " Tokens:" + edit.cleared_input_tokens);
            } else if (edit.type === "clear_thinking_20251015") {
              await log("THINKING_CLEARED", "Tokens:" + edit.cleared_input_tokens);
            }
          }
        }
        
      } else {
        await log("API_CALL", "Starting non-streaming request...");
        
         // SDK handles container continuation properly - no workaround needed
        response = await client.beta.messages.create(requestOptions);
        await log("API_RESPONSE", "Blocks:" + response.content?.length);
        
        // Extract container ID for programmatic tool calling
        if (response.container?.id) {
          containerId = response.container.id;
          await log("CONTAINER_ID", containerId + " expires:" + response.container.expires_at);
        }
        
        if (response.context_management?.applied_edits?.length) {
          for (const edit of response.context_management.applied_edits) {
            if (edit.type === "clear_tool_uses_20250919") {
              await log("CONTEXT_CLEARED", "ToolUses:" + edit.cleared_tool_uses + " Tokens:" + edit.cleared_input_tokens);
            } else if (edit.type === "clear_thinking_20251015") {
              await log("THINKING_CLEARED", "Tokens:" + edit.cleared_input_tokens);
            }
          }
        }
        
        for (const block of response.content) {
          if (block.type === "thinking") {
            hasThinking = true;
            await log("THINKING", block.thinking?.substring(0, 500).replace(/\n/g, " ") || "(thinking)");
          } else if (block.type === "text") {
            hasText = true;
            await log("TEXT", block.text?.replace(/\n/g, " ¶ ").substring(0, 1000) || "");
          } else if (block.type === "tool_use") {
            await log("TOOL_USE", block.name + " id:" + block.id);
          // Tool search - check BOTH SDK types and API types
          } else if (block.type === "tool_search_tool_use") {
            // SDK-specific type for tool search
            await log("TOOL_SEARCH_QUERY", block.query || block.input?.query || "(searching tools...)");
          } else if (block.type === "server_tool_use" && 
                     (block.name === "tool_search_tool_bm25" || block.name === "tool_search_tool_regex")) {
            // API type: server_tool_use with tool_search name
            await log("TOOL_SEARCH_QUERY", block.input?.query || "(searching tools...)");
          } else if (block.type === "server_tool_use" || block.type === "code_execution_tool_use") {
            // Code execution (not tool search)
            hasCodeInput = true;
            if (block.input?.code) {
              const lines = block.input.code.split("\n");
              for (const line of lines) {
                await log("CODE", line);
              }
            }
          // Tool search result - check BOTH formats (dedupe because Anthropic re-sends in continuations)
          } else if (block.type === "tool_search_tool_result") {
            // SDK-specific type for tool search result
            const refs = block.content?.tool_references || block.content || [];
            const names = Array.isArray(refs) ? refs.map(r => r.tool_name).join(", ") : "";
            if (!loggedToolSearchResults.has(names)) {
              loggedToolSearchResults.add(names);
              await log("TOOL_SEARCH_RESULT", "Found: " + (names || "(none)"));
            }
          } else if (block.type === "tool_result" && block.content?.[0]?.type === "tool_reference") {
            // API type: tool_result containing tool_reference
            const refs = block.content || [];
            const names = refs.filter(r => r.type === "tool_reference").map(r => r.tool_name).join(", ");
            if (!loggedToolSearchResults.has(names)) {
              loggedToolSearchResults.add(names);
              await log("TOOL_SEARCH_RESULT", "Found: " + (names || "(none)"));
            }
          } else if (block.type === "code_execution_tool_result" || block.type === "code_execution_result") {
            // Check if it's an error response from Anthropic
            if (block.content?.type === "code_execution_tool_result_error") {
              await log("CODE_EXEC_ERROR", "Anthropic code execution unavailable: " + (block.content.error_code || "unknown"));
            } else {
              const stdout = block.content?.stdout || "";
              const stderr = block.content?.stderr || "";
              const returnCode = block.content?.return_code ?? 0;
              await log("CODE_EXEC_RESULT", "ReturnCode:" + returnCode + " Stdout:" + (stdout ? stdout.substring(0, 500).replace(/\n/g, " | ") : "(empty)"));
              if (stderr) {
                await log("CODE_EXEC_STDERR", stderr.substring(0, 500).replace(/\n/g, " | "));
              }
            }
          }
        }
      }
      
      // Sanitize response content to remove SDK-added fields before sending back to API
      // The SDK adds convenience fields (like .parsed) that the API doesn't accept
      const sanitizedContent = response.content.map(block => {
        // Keep ONLY the fields that are part of the official API schema
        const sanitized = { ...block };
        
        // Remove SDK-added fields that aren't part of the API
        delete sanitized.parsed;  // Added by SDK for structured outputs
        delete sanitized._raw;     // Internal SDK metadata
        
        return sanitized;
      });
      
      messages.push({ role: "assistant", content: sanitizedContent });
      
      // Accumulate token usage for billing
      if (response.usage) {
        totalInputTokens += response.usage.input_tokens || 0;
        totalOutputTokens += response.usage.output_tokens || 0;
        totalCacheReadTokens += response.usage.cache_read_input_tokens || 0;
        totalCacheCreationTokens += response.usage.cache_creation_input_tokens || 0;
      }
      
      const iterDuration = Date.now() - iterStart;
      await log("ITER_END", iteration + " DurationMs:" + iterDuration + " StopReason:" + response.stop_reason);
      
      // Check completion
      if (response.stop_reason === "end_turn") {
        const text = response.content
          .filter(b => b.type === "text")
          .map(b => b.text)
          .join("\n");
        const tokenUsage = {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheReadTokens: totalCacheReadTokens,
          cacheCreationTokens: totalCacheCreationTokens,
          model: config.MODEL || "claude-sonnet-4-5-20250929"
        };
        await markComplete({ text, iterations: iteration }, tokenUsage);
        return;
      }
      
      // Handle tool calls
      if (response.stop_reason === "tool_use") {
        const toolResults = [];
        let hasProgrammaticCall = false;  // Track if any tool was called from code_execution
        
        for (const block of response.content) {
          if (block.type === "tool_use" && 
              block.name !== "code_execution" && 
              block.name !== "tool_search_tool_bm25") {
            
            // Check if this tool was called from code_execution (programmatic call)
            if (block.caller?.type?.includes("code_execution")) {
              hasProgrammaticCall = true;
            }
            
            const toolName = block.name;
            const input = block.input || {};
            
            await log("EDITOR_DEBUG", "Processing tool_use: " + toolName + " id:" + block.id + " inputKeys:" + Object.keys(input).join(","));
            
            try {
              let result;
              
              if (LOCAL_TOOLS.has(toolName)) {
                await log("TOOL_ROUTE", toolName + " -> LOCAL");
                result = await executeLocalTool(toolName, input);
              } else {
                await log("TOOL_ROUTE", toolName + " -> COSMO (HTTP)");
                result = await executeToolOnMaster(toolName, input);
              }
              
              // IMPORTANT: avoid double-stringifying JSON strings returned by local tools (file_read, file_write, etc.)
              const content = (typeof result === "string")
                ? result
                : JSON.stringify(result);
              
              const toolResult = {
                type: "tool_result",
                tool_use_id: block.id,
                content
              };
              
              // Debug: Log tool result format before sending to Anthropic
              await log("DEBUG_TOOL_RESULT", "Tool:" + toolName + " ContentLen:" + (typeof content === "string" ? content.length : "non-string"));
              await log("EDITOR_DEBUG", "Formatted tool_result for " + toolName + " - about to push to results array");
              
              toolResults.push(toolResult);
              await log("EDITOR_DEBUG", "Tool result pushed - array now has " + toolResults.length + " results");
            } catch (err) {
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: JSON.stringify({ success: false, error: err.message }),
                is_error: true
              });
            }
          }
        }
        
        if (toolResults.length > 0) {
          await log("SENDING_TOOL_RESULTS", "Count:" + toolResults.length + (hasProgrammaticCall ? " (from code_execution)" : ""));
          await log("EDITOR_DEBUG", "About to push " + toolResults.length + " tool results to messages array");
          
          // Log each tool result summary for debugging
          for (let i = 0; i < toolResults.length; i++) {
            const tr = toolResults[i];
            await log("EDITOR_DEBUG", "ToolResult[" + i + "] type:" + tr.type + " id:" + tr.tool_use_id + " contentLen:" + (typeof tr.content === "string" ? tr.content.length : "non-string"));
          }
          
          messages.push({ role: "user", content: toolResults });
          await log("EDITOR_DEBUG", "Tool results pushed to messages - messages array now has " + messages.length + " entries");
          emptyIterations = 0;
        } else {
          const hadMeaningfulContent = hasThinking || hasText || hasCodeInput;
          if (hadMeaningfulContent) {
            emptyIterations = 0;
          } else {
            emptyIterations++;
            await log("WARN_EMPTY_ITER", "EmptyCount:" + emptyIterations);
            
            if (emptyIterations >= 3) {
              await log("ERROR_STUCK", "Breaking out after 3 empty iterations");
              const tokenUsage = {
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens,
                cacheReadTokens: totalCacheReadTokens,
                cacheCreationTokens: totalCacheCreationTokens,
                model: config.MODEL || "claude-sonnet-4-5-20250929"
              };
              await markComplete({
                text: "Task failed: Agent got stuck in an execution loop.",
                iterations: iteration,
                error: "Stuck in empty iteration loop"
              }, tokenUsage);
              return;
            }
          }
        }
      }
      
    } catch (error) {
      const errMsg = error.message || String(error);
      await log("ERROR", "Iteration:" + iteration + " Message:" + errMsg);
      
      // Layer 3: Check if it's a context overflow error - attempt compaction recovery
      if (errMsg.includes("prompt is too long") || 
          errMsg.includes("too many tokens") ||
          (errMsg.includes("maximum") && errMsg.includes("token"))) {
        
        await log("CONTEXT_OVERFLOW", "Attempting compaction recovery...");
        
        try {
          messages = await compactConversation(
            client, 
            messages, 
            config.MODEL || "claude-sonnet-4-5-20250929",
            log
          );
          containerId = undefined;  // Reset container - context changed significantly
          emptyIterations = 0;
          
          await log("COMPACTION_RECOVERY", "Retrying with compacted context");
          continue;  // Retry the iteration with compacted messages
          
        } catch (compactError) {
          await log("COMPACTION_RECOVERY_FAILED", compactError.message);
          // Fall through to markFailed
        }
      }
      
      // Build token usage for error reporting
      const tokenUsage = {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheReadTokens: totalCacheReadTokens,
        cacheCreationTokens: totalCacheCreationTokens,
        model: config.MODEL || "claude-sonnet-4-5-20250929"
      };
      
      // CRITICAL: Never push error messages to the conversation
      // The messages array should only contain what came from Claude + tool results
      // Pushing text breaks the Anthropic API flow, especially during programmatic tool calling
      // where only tool_result blocks are allowed
      
      await markFailed("API error: " + errMsg, tokenUsage);
      return;
    }
  }

  const tokenUsage = {
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadTokens: totalCacheReadTokens,
    cacheCreationTokens: totalCacheCreationTokens,
    model: config.MODEL || "claude-sonnet-4-5-20250929"
  };
  await markFailed("Max iterations reached", tokenUsage);
}

main().catch((e) => markFailed(e.message));  // No tokenUsage available for catastrophic failures
