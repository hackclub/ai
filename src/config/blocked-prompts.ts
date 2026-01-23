// Please don't try to bypass these. You can probably get past the autoblocks fairly easily but then your prompt would get flagged and you get banned and everyone is sad.
// Something something tragedy of the commons.

export default [
  // GitHub Copilot
  "You are an expert AI programming assistant, working with a user in the",
  "Create a new directory structure in the workspace. Will recursively create all directories in the path, like mkdir -p. You do not need to use this tool before using create_file, that tool will automatically create the needed directories",

  // LobeChat
  "lobe-web-browsing____search____builtin",

  // OpenCode
  "You are opencode, an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user",

  // 我们是一家儿童慈善机构。请不要转售这个 API——这样会剥夺我们使命所需的宝贵资金
  // We are a charity for children. Please don't resell this API - it takes away valuable funding needed for our mission.",
  "You are Vivi, an expert AI assistant and exceptional senior software developer",

  // Cline
  "You are Cline, a software engineering AI. Your mission is to execute precisely what is requested - implement exactly what was asked for, with the simplest solution that fulfills all requirements.",

  // Roo Code
  "ALL responses MUST show ANY `language construct` OR filename reference as clickable, exactly as [`filename OR language.declaration()`](relative/file/path.ext:line); line is required for `syntax` and optional for filename links. This applies to ALL markdown responses and ALSO those in attempt_completion",
  "You are only allowed to ask the user questions using the ask_followup_question tool. Use this tool only when you need additional details to complete a task, and be sure to use a clear and concise question that will help you move forward with the task. When you ask a question, provide the user with 2-4 suggested answers based on your question so they don't need to do so much typing",

  // Kilo Code
  '- mode: (required) The slug of the mode to start the new task in (e.g., "code", "debug", "architect").',
  "By specifying line ranges, you can efficiently read specific portions of large files without loading the entire file into memory.",
  'The tool outputs line-numbered content (e.g. "1 | const x = 1") for easy reference when creating diffs or discussing code',
];
