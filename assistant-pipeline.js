// assistant-pipeline.js
// Replaces Nova's custom pipeline with OpenAI Assistants API integration
// npm install openai axios
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ASSISTANT_ID = process.env.NOVA_ASSISTANT_ID || 'asst_gNwlaKVPMnTeORVkbXs5EqeV'; // Hardcoded fallback

// Optional HTTP fallback for tool handling if no toolExecutor is provided
async function httpToolHandler(toolName, args) {
  const url = `http://localhost:4001/tool/${toolName}`;
  const { default: axios } = await import('axios');
  const res = await axios.post(url, args);
  return res.data;
}

// Main pipeline function
export async function runAssistantPipeline({ userInput, threadId, toolExecutor, actionContext = 'general', metadata = {} }) {
  if (!ASSISTANT_ID) throw new Error('NOVA_ASSISTANT_ID not set');
  if (userInput === undefined || userInput === null) throw new Error('User input required');

  console.log(`[DEBUG] threadId received: ${JSON.stringify(threadId)}`);

  // Create or continue a thread
  const thread = (threadId && threadId.trim())
    ? { id: threadId }
    : await openai.beta.threads.create();

  console.log(`[DEBUG] thread created/used: ${JSON.stringify(thread)}`);
  
  // Store thread ID in a separate variable to avoid any scope issues
  const currentThreadId = thread.id;
  console.log(`[DEBUG] currentThreadId: ${currentThreadId}`);

  // Add user message (only if we have input)
  if (userInput.trim()) {
    await openai.beta.threads.messages.create(currentThreadId, {
      role: 'user',
      content: userInput
    });
  }

  console.log(`[DEBUG] About to create run with currentThreadId: ${currentThreadId}`);

  // Build targeted additional instructions to strongly encourage actual tool calls
  const addl = [];
  addl.push('IMPORTANT: You must call the appropriate function tool to execute your decision. Saying "I will do X" without calling the function is not allowed.');
  if (actionContext === 'email') {
    const acc = metadata.accountId ? String(metadata.accountId) : undefined;
    const subj = metadata.subject ? String(metadata.subject) : undefined;
    addl.push(`Processing email: account="${acc}", subject="${subj}".`);
    addl.push('For promotional/spam emails: call mark_spam function with account and subject parameters.');
    addl.push('For important emails: call notify_owner function.');
    addl.push('For follow-ups: call schedule_reminder function.');
    addl.push('You MUST call one of these functions - do not just describe your decision.');
  }

  // Run the assistant with tool_choice to force function calling when appropriate
  const run = await openai.beta.threads.runs.create(currentThreadId, {
    assistant_id: ASSISTANT_ID,
    additional_instructions: addl.join(' '),
    tool_choice: actionContext === 'email' ? 'required' : 'auto'
  });

  console.log(`[DEBUG] Run created: ${JSON.stringify({ id: run.id, status: run.status })}`);

  // Poll for completion
  let status = run.status;
  let runResult = run;
  while (status !== 'completed' && status !== 'failed' && status !== 'cancelled' && status !== 'requires_action') {
    await new Promise(r => setTimeout(r, 1500));
    console.log(`[DEBUG] About to retrieve run with currentThreadId: ${currentThreadId}, run.id: ${run.id}`);
    runResult = await openai.beta.threads.runs.retrieve(run.id, { thread_id: currentThreadId });
    status = runResult.status;
    console.log(`[DEBUG] Run status: ${status}`);
  }

  console.log(`[DEBUG] Final status: ${status}, required_action: ${!!runResult.required_action}`);

  // Handle tool calls
  let executedTools = [];
  if (runResult.required_action && runResult.required_action.submit_tool_outputs) {
    console.log(`[DEBUG] Processing ${runResult.required_action.submit_tool_outputs.tool_calls.length} tool calls`);
    const toolCalls = runResult.required_action.submit_tool_outputs.tool_calls;
    const toolOutputs = [];
    
    for (const call of toolCalls) {
      const toolName = call.function.name;
      const args = JSON.parse(call.function.arguments);
      console.log(`[DEBUG] Executing tool: ${toolName} with args:`, args);
      
      // Prefer in-process executor (ActionExecutor) when available; fallback to HTTP handler
      let result;
      try {
        if (typeof toolExecutor === 'function') {
          // Map tool call to ActionExecutor plan
          const plan = { action: toolName, ...args };
          result = await toolExecutor(plan);
          console.log(`[DEBUG] Tool ${toolName} result:`, result);
        } else {
          result = await httpToolHandler(toolName, args);
        }
      } catch (err) {
        console.error(`[TOOL EXEC ERROR] ${toolName}:`, err.message);
        result = { success: false, error: err.message };
      }
      executedTools.push(toolName);
      toolOutputs.push({ tool_call_id: call.id, output: JSON.stringify(result) });
    }
    
    // Submit tool outputs
    console.log(`[DEBUG] Submitting ${toolOutputs.length} tool outputs`);
    await openai.beta.threads.runs.submitToolOutputs(run.id, { thread_id: currentThreadId, tool_outputs: toolOutputs });
    
    // Poll again for completion after tool outputs
    let finalStatus = 'in_progress';
    let finalRunResult = runResult;
    while (finalStatus !== 'completed' && finalStatus !== 'failed' && finalStatus !== 'cancelled') {
      await new Promise(r => setTimeout(r, 1500));
      finalRunResult = await openai.beta.threads.runs.retrieve(run.id, { thread_id: currentThreadId });
      finalStatus = finalRunResult.status;
      console.log(`[DEBUG] Post-tool status: ${finalStatus}`);
    }
    runResult = finalRunResult;
  }

  // Get the latest message from the assistant
  const messages = await openai.beta.threads.messages.list(currentThreadId);
  const lastMsg = messages.data.find(m => m.role === 'assistant');
  
  console.log(`[DEBUG] Executed tools: ${executedTools.length > 0 ? executedTools.join(', ') : 'none'}`);
  
  return {
    threadId: currentThreadId,
    text: lastMsg ? lastMsg.content[0].text.value : null,
    actions: executedTools
  };
}
