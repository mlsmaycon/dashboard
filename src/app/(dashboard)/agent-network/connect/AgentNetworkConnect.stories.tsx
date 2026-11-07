import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import ConnectPage from "@/app/(dashboard)/agent-network/connect/page";
import DashboardLayout from "@/layouts/DashboardLayout";
import {
  agentConfig,
  agentConfigWithChatGPT,
  chatgptConfigProvider,
  linkFlow,
} from "@/storybook/fixtures";
import {
  clickRole,
  dialog,
  findText,
  popover,
  settle,
} from "@/storybook/platform";

const meta: Meta = {
  title: "Pages/Platform/Agent Network/Connect",
  parameters: {
    nextjs: { navigation: { pathname: "/agent-network/connect" } },
  },
  render: () => (
    <DashboardLayout>
      <ConnectPage />
    </DashboardLayout>
  ),
};
export default meta;
type Story = StoryObj;

const loaded = async () => {
  await findText(/acme\.ai\.eu\.proxy\.netbird\.io/);
  await settle();
};

export const ClaudeCode: Story = { play: loaded };

export const ProviderPickerOpen: Story = {
  play: async () => {
    await loaded();
    await clickRole("button", /Anthropic Claude/);
    await popover();
    await settle();
  },
};

export const ModelPickerOpen: Story = {
  play: async () => {
    await loaded();
    await clickRole("button", /claude-sonnet-4-5/);
    await popover();
    await settle();
  },
};

const tabStory = (name: RegExp): Story => ({
  play: async () => {
    await loaded();
    await clickRole("tab", name);
    await settle();
  },
});
export const Codex = tabStory(/Codex/);
export const OpenCode = tabStory(/OpenCode/);
export const Pi = tabStory(/^Pi$/);
export const SDK = tabStory(/SDK/);
export const Curl = tabStory(/curl/i);

export const NotCovered: Story = {
  parameters: {
    api: {
      "GET /agent-network/agent-config": {
        configured: true,
        endpoint: "https://acme.ai.eu.proxy.netbird.io",
        providers: [],
      },
    },
  },
  play: loaded,
};

/* A ChatGPT provider takes the caller's own subscription, so the table grows a Subscription column. */
const chatgptStory = (
  status: "linked" | "not_linked" | "needs_relink",
): Story => ({
  parameters: {
    api: { "GET /agent-network/agent-config": agentConfigWithChatGPT(status) },
  },
  play: async () => {
    await loaded();
    await findText("ChatGPT");
    await settle();
  },
});
export const ChatGPTNotLinked = chatgptStory("not_linked");
export const ChatGPTLinked = chatgptStory("linked");
export const ChatGPTNeedsRelink = chatgptStory("needs_relink");

/* With only a ChatGPT provider the page opens on Codex, pointed at /backend-api/codex. */
export const ChatGPTOnly: Story = {
  parameters: {
    api: {
      "GET /agent-network/agent-config": {
        ...agentConfig,
        providers: [chatgptConfigProvider("not_linked")],
      },
    },
  },
  play: async () => {
    await loaded();
    await findText(/backend-api\/codex/);
    await settle();
  },
};

export const ChatGPTLinkPending: Story = {
  parameters: ChatGPTNotLinked.parameters,
  play: async () => {
    await loaded();
    await clickRole("button", /Link ChatGPT/);
    await dialog();
    await findText("WDJB-MJHT");
    await settle();
  },
};

export const ChatGPTLinkExpired: Story = {
  parameters: {
    api: {
      ...ChatGPTNotLinked.parameters?.api,
      "GET /agent-network/providers/:id/link/:flowId": linkFlow("expired"),
    },
  },
  play: async () => {
    await loaded();
    await clickRole("button", /Link ChatGPT/);
    await findText(/code expired/);
    await settle();
  },
};
