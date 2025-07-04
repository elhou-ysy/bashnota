import type {
  CodeBlock,
  ExecutionResult,
  JupyterMessage,
  MessageStatus,
} from '@/features/editor/types/codeExecution'
import type { JupyterServer } from '@/features/jupyter/types/jupyter'
import { logger } from '@/services/logger'

export class CodeExecutionService {
  private getBaseUrl(server: JupyterServer): string {
    const protocol = server.ip.startsWith('http') ? '' : 'http://'
    return `${protocol}${server.ip}:${server.port}`
  }

  private getUrlWithToken(serverConfig: JupyterServer, endpoint: string): string {
    const url = `${this.getBaseUrl(serverConfig)}${endpoint}`

    if (serverConfig.token) {
      return `${url}?token=${serverConfig.token}`
    }
    return url
  }

  private getWebSocketUrl(serverConfig: JupyterServer, kernelId: string): string {
    const baseUrl = this.getBaseUrl(serverConfig)
      .replace('http://', 'ws://')
      .replace('https://', 'wss://')

    const url = `${baseUrl}/api/kernels/${kernelId}/channels`

    if (serverConfig.token) {
      return `${url}?token=${serverConfig.token}`
    }
    return url
  }

  private createExecuteRequestMessage(code: string): JupyterMessage {
    const msgId = `msg-${Date.now()}-${Math.random()}`
    return {
      header: {
        msg_id: msgId,
        username: 'bashbook',
        session: msgId,
        msg_type: 'execute_request',
        version: '5.0',
      },
      parent_header: {},
      metadata: {},
      content: {
        code,
        silent: false,
        store_history: true,
        user_expressions: {},
        allow_stdin: false,
      },
      channel: 'shell',
    }
  }

  async createKernel(serverConfig: JupyterServer, kernelName: string): Promise<string> {
    try {
      const url = this.getUrlWithToken(serverConfig, '/api/kernels');
      logger.log(`Creating kernel '${kernelName}' at ${url}`);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: kernelName }),
      });

      const responseText = await response.text();
      
      if (!response.ok) {
        logger.error(`Failed to create kernel: Status ${response.status}`, responseText);
        throw new Error(`Failed to create kernel: ${response.status} ${response.statusText}${responseText ? ` - ${responseText}` : ''}`);
      }

      try {
        const data = JSON.parse(responseText);
        logger.log(`Successfully created kernel with ID: ${data.id}`);
        return data.id;
      } catch (parseError) {
        logger.error('Failed to parse kernel creation response:', responseText, parseError);
        throw new Error('Invalid response format from Jupyter server');
      }
    } catch (error) {
      logger.error('Error in kernel creation:', error);
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Failed to create kernel: ${String(error)}`);
    }
  }

  async deleteKernel(serverConfig: JupyterServer, kernelId: string): Promise<void> {
    const response = await fetch(this.getUrlWithToken(serverConfig, `/api/kernels/${kernelId}`), {
      method: 'DELETE',
    })

    if (!response.ok) {
      throw new Error(`Failed to delete kernel: ${response.statusText}`)
    }
  }

  async listKernels(serverConfig: JupyterServer): Promise<Array<{ id: string; name: string }>> {
    const response = await fetch(this.getUrlWithToken(serverConfig, '/api/kernels'), {
      method: 'GET',
    })

    if (!response.ok) {
      throw new Error(`Failed to list kernels: ${response.statusText}`)
    }

    return response.json()
  }

  executeNotebookBlocks(
    serverConfig: JupyterServer,
    kernelId: string,
    codeBlocks: CodeBlock[],
    onOutput?: (blockId: string, output: string) => void,
  ): Promise<ExecutionResult[]> {
    return new Promise((resolve, reject) => {
      const results: Map<string, string> = new Map()
      const ws = new WebSocket(this.getWebSocketUrl(serverConfig, kernelId))
      let currentBlockIndex = 0
      const messageStatus = new Map<string, MessageStatus>()

      ws.onopen = () => {
        if (codeBlocks.length > 0) {
          const message = this.createExecuteRequestMessage(codeBlocks[currentBlockIndex].code)
          messageStatus.set(message.header.msg_id, { done: false, output: '' })
          ws.send(JSON.stringify(message))
        }
      }

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data)
        const msgType = msg.header?.msg_type
        const parentMsgId = msg.parent_header?.msg_id

        if (!parentMsgId || !messageStatus.has(parentMsgId)) return

        const status = messageStatus.get(parentMsgId)!
        const content = msg.content
        let newOutput = ''

        switch (msgType) {
          case 'stream':
            newOutput = content.text || ''
            status.output += newOutput
            break

          case 'execute_result':
          case 'display_data':
            if (content.data['text/plain']) {
              newOutput += content.data['text/plain'] + '\n'
            }
            if (content.data['text/html']) {
              newOutput += content.data['text/html'] + '\n'
            }
            if (content.data['image/png']) {
              newOutput += `<img src="data:image/png;base64,${content.data['image/png']}" />\n`
            }
            status.output += newOutput
            break

          case 'error':
            newOutput += `Error: ${content.ename}\n${content.evalue}\n${content.traceback.join('\n')}`
            status.output += newOutput
            codeBlocks[currentBlockIndex].hasError = true
            break

          case 'status':
            if (content.execution_state === 'idle' && !status.done) {
              status.done = true
              results.set(codeBlocks[currentBlockIndex].id, status.output)

              currentBlockIndex++
              if (currentBlockIndex < codeBlocks.length) {
                const nextMessage = this.createExecuteRequestMessage(
                  codeBlocks[currentBlockIndex].code,
                )
                messageStatus.set(nextMessage.header.msg_id, {
                  done: false,
                  output: '',
                })
                ws.send(JSON.stringify(nextMessage))
              } else {
                ws.close()
                resolve(
                  codeBlocks.map((block) => ({
                    id: block.id,
                    hasError: block.hasError,
                    output: results.get(block.id) || '',
                  })),
                )
              }
            }
            break
        }

        // Stream output if callback is provided
        if (newOutput && onOutput) {
          onOutput(codeBlocks[currentBlockIndex].id, newOutput)
        }
        messageStatus.set(parentMsgId, status)
      }

      ws.onerror = (error) => {
        logger.error('WebSocket error:', error)
        reject(new Error('WebSocket error'))
      }

      ws.onclose = () => {
        if (currentBlockIndex < codeBlocks.length) {
          reject(new Error('WebSocket closed before execution completed'))
        }
      }
    })
  }

  async executeCode(
    serverConfig: JupyterServer,
    kernelId: string,
    code: string,
    onOutput?: (output: string) => void,
  ): Promise<ExecutionResult> {
    const results = await this.executeNotebookBlocks(
      serverConfig,
      kernelId,
      [{ id: 'single', notebookId: 'temp', code }],
      (_, output) => onOutput?.(output),
    )
    return results[0]
  }
}








