# RCSB PDB Explorer: An AI Assistant for Protein Data

## License and Citation

This project is available under the MIT License with an Academic Citation Requirement. This means you can freely use, modify, and distribute the code, but any academic or scientific publication that uses this software must provide appropriate attribution.

### For academic/research use:
If you use this software in a research project that leads to a publication, presentation, or report, you **must** cite this work according to the format provided in [CITATION.md](CITATION.md).

### For commercial/non-academic use:
Commercial and non-academic use follows the standard MIT License terms without the citation requirement.

By using this software, you agree to these terms. See [LICENSE.md](LICENSE.md) for the complete license text.This project provides an "AI assistant" (called an MCP Server) that's specialized in understanding and retrieving information from the RCSB Protein Data Bank (PDB). Think of it as a helper that allows advanced AI models, like Claude, to directly access and use PDB data to answer your questions.

## What can it do?

With this server, you can ask an AI (like Claude, when connected) to:
*   Fetch details about specific PDB entries (e.g., "What is the experimental method used for PDB entry 4HHB?").
*   Retrieve information about molecules, sequences, and experimental data.
*   Query Computed Structure Models (CSMs).
*   And much more, by giving the AI the ability to make specific queries to the PDB's GraphQL API.

Essentially, it bridges the gap between conversational AI and the rich, structured data available in the RCSB PDB.

## How to Use This AI Assistant (for an Existing Server)

If this AI assistant has already been set up and deployed (e.g., by a colleague or IT department), you can connect to it using a compatible AI interface. Here are a couple of common ways:

### 1. Using the Cloudflare AI Playground

The Cloudflare AI Playground is a website where you can test AI models and connect them to "tools" like this PDB Explorer.

1.  **Get the Server URL**: You'll need the specific web address (URL) of the deployed RCSB PDB Explorer server. It will look something like `https://rcsb-pdb-mcp-server.<your-organization>.workers.dev/sse`.
2.  **Go to the AI Playground**: Open your web browser and navigate to [https://playground.ai.cloudflare.com/](https://playground.ai.cloudflare.com/).
3.  **Connect Your Server**:
    *   Look for an option to add or connect a "Custom MCP Server" or "Tool Server."
    *   Enter the Server URL you obtained in step 1.
4.  **Start Querying**: Once connected, you can chat with the AI in the playground. When you ask questions related to PDB data, the AI will be able to use the PDB Explorer to find answers. For example, try asking: "Get the title and experimental method for PDB ID 1EHZ."

### 2. Using the Claude Desktop App

If you use the Claude Desktop application, you can configure it to connect to this PDB Explorer. This allows Claude to use the PDB tools directly within your desktop app.

1.  **Get the Server URL**: Just like with the AI Playground, you need the URL of the deployed RCSB PDB Explorer server (e.g., `https://rcsb-pdb-mcp-server.quentincody.workers.dev/sse`).
2.  **Configure Claude Desktop**:
    *   Open the Claude Desktop app.
    *   Go to `Settings` > `Developer` > `Edit Config`. This will open a JSON configuration file.
    *   You need to add an entry for the PDB Explorer. It should look like this (you might have other servers already listed):

    ```json
    {
      "mcpServers": {
        // ... (other servers might be here) ...

        "rcsb-pdb": {
          "command": "npx",
          "args": [
            "mcp-remote",
            "YOUR_RCSB_PDB_SERVER_URL_HERE" // <-- Replace this with the actual server URL
          ]
        }
      }
    }
    ```
    *   **Important**: Replace `"YOUR_RCSB_PDB_SERVER_URL_HERE"` with the actual URL you got in step 1. For example: `"https://rcsb-pdb-mcp-server.quentincody.workers.dev/sse"`.
3.  **Restart Claude**: Close and reopen the Claude Desktop app.
4.  **Use the Tool**: Now, when you chat with Claude, it will have access to the RCSB PDB Explorer. You can ask it questions like: "Fetch the abstract for PDB entry 2DRI."

## For Developers (Setting up your own server)

If you are a developer and want to deploy your own instance of this server or customize it, please refer to the original template and documentation for [Cloudflare Workers AI demos](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-authless). The core logic for this PDB tool is in `src/index.ts`.

---

This README aims to make it easier for scientists to leverage the power of AI with their PDB research data. Enjoy exploring!
