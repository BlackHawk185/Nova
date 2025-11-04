// check-assistant.js - Quick script to verify assistant configuration
import 'dotenv/config';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ASSISTANT_ID = process.env.NOVA_ASSISTANT_ID;

async function main() {
  if (!ASSISTANT_ID) {
    console.error('NOVA_ASSISTANT_ID not set');
    process.exit(1);
  }

  try {
    const assistant = await openai.beta.assistants.retrieve(ASSISTANT_ID);
    console.log('Assistant Info:');
    console.log('- ID:', assistant.id);
    console.log('- Model:', assistant.model);
    console.log('- Name:', assistant.name);
    console.log('- Tools count:', assistant.tools?.length || 0);
    
    if (assistant.tools && assistant.tools.length > 0) {
      console.log('\nRegistered Tools:');
      assistant.tools.forEach((tool, i) => {
        if (tool.type === 'function') {
          console.log(`  ${i + 1}. ${tool.function.name} - ${tool.function.description}`);
        } else {
          console.log(`  ${i + 1}. ${tool.type}`);
        }
      });
    } else {
      console.log('\n❌ No tools registered!');
    }
    
    console.log('\nInstructions preview:');
    console.log(assistant.instructions?.substring(0, 200) + '...');
  } catch (err) {
    console.error('Failed to retrieve assistant:', err.message);
  }
}

main();