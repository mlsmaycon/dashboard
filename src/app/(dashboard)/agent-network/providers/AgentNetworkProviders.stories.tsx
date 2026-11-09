import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import ProvidersPage from "@/app/(dashboard)/agent-network/providers/page";
import DashboardLayout from "@/layouts/DashboardLayout";
import {
  agentProviders,
  chatgptProvidersByLoginState,
  claudeLinkFlow,
  claudeProvidersByLoginState,
} from "@/storybook/fixtures";
import {
  click,
  clickRole,
  clickTestId,
  dialog,
  findText,
  settle,
  type,
  waitForSelector,
} from "@/storybook/platform";

const meta: Meta = {
  title: "Pages/Platform/Agent Network/Providers",
  parameters: {
    nextjs: { navigation: { pathname: "/agent-network/providers" } },
  },
  render: () => (
    <DashboardLayout>
      <ProvidersPage />
    </DashboardLayout>
  ),
};
export default meta;
type Story = StoryObj;

const loaded = async () => {
  await findText("OpenAI Production");
  await settle();
};

export const List: Story = {
  tags: ["capture-hover"],
  play: async () => {
    await loaded();
    (await findText("Azure OpenAI (EU West)"))
      .closest("tr")
      ?.setAttribute("data-capture", "");
  },
};

export const RowMenu: Story = {
  play: async () => {
    await loaded();
    const buttons = (await findText("Azure OpenAI (EU West)"))
      .closest("tr")
      ?.querySelectorAll("button");
    await click(buttons?.[buttons.length - 1]);
    await waitForSelector("[role=menu]");
    await settle();
  },
};

/* Before the first provider the endpoint is not bootstrapped, so the header offers to set it up. */
export const Empty: Story = {
  parameters: {
    api: {
      "GET /agent-network/providers": [],
      "GET /agent-network/settings": {
        endpoint: "",
        proxy_address: "",
        dedicated: false,
        enable_log_collection: false,
        enable_prompt_collection: false,
        redact_pii: false,
      },
    },
  },
  play: async () => {
    await findText("Connect a provider");
    await settle();
  },
};

async function openConnect() {
  await loaded();
  await clickTestId("connect-agent-network-provider");
  return dialog();
}

export const ConnectModal: Story = {
  play: async () => {
    await openConnect();
    await settle();
  },
};

export const ConnectModalProviderDropdown: Story = {
  play: async () => {
    await openConnect();
    await clickTestId("agent-network-provider-type");
    await findText(/Search providers/).catch(() => undefined);
    await settle();
  },
};

/* Options render once scrolled into view, so the ones below the fold are searched for first. */
async function pickProvider(search: string, id: string) {
  await ConnectModalProviderDropdown.play!({} as never);
  await type(
    await waitForSelector("input[placeholder='Search providers...']"),
    search,
  );
  await clickTestId(`agent-network-provider-option-${id}`);
}

async function connectLiteLLM() {
  await pickProvider("LiteLLM", "litellm_proxy");
  await settle();
  const modal = await dialog();
  await type(
    modal.querySelector(
      "[data-testid=agent-network-provider-api-key] input, input[data-testid=agent-network-provider-api-key]",
    ),
    "sk-regression-test-key",
  );
  await settle();
}

export const ConnectModalFilled: Story = { play: connectLiteLLM };

export const ConnectModalModelsTab: Story = {
  play: async () => {
    await connectLiteLLM();
    await clickTestId("agent-network-provider-models-tab");
    await settle();
  },
};

export const ConnectModalMappingsTab: Story = {
  play: async () => {
    await connectLiteLLM();
    await clickTestId("agent-network-provider-mappings-tab");
    await settle();
  },
};

const editStory = (name: string, tab?: "Models" | "Mappings"): Story => ({
  play: async () => {
    await loaded();
    await click(await findText(name));
    await findText("Edit Provider");
    if (tab) await clickRole("tab", tab);
    await settle();
  },
});

export const EditOpenAI = editStory("OpenAI Production");
export const EditOpenAIModels = editStory("OpenAI Production", "Models");
export const EditAnthropicModels = editStory("Anthropic Claude", "Models");
export const EditBedrock = editStory("AWS Bedrock");
export const EditBedrockMappings = editStory("AWS Bedrock", "Mappings");
export const EditLiteLLMMappings = editStory("LiteLLM Gateway", "Mappings");
export const EditBifrostMappings = editStory("Bifrost", "Mappings");
export const EditVLLM = editStory(
  "Self-hosted vLLM cluster in the Frankfurt datacenter (GPU rack 4)",
);

/* OpenAI offers a ChatGPT login next to the API key: no key field, the upstream locked to chatgpt.com,
   and a warning that everyone the policies cover shares the plan. */
async function chooseChatGPTLogin() {
  await openConnect();
  await clickTestId("agent-network-provider-auth-login");
  await findText(/shares one ChatGPT plan/);
  await settle();
}

export const ConnectModalChatGPTLogin: Story = { play: chooseChatGPTLogin };

export const ConnectModalChatGPTModels: Story = {
  play: async () => {
    await chooseChatGPTLogin();
    await clickTestId("agent-network-provider-models-tab");
    await settle();
  },
};

/* Connecting a ChatGPT-login provider moves straight on to linking its login. */
export const ConnectModalChatGPTLinkPending: Story = {
  play: async () => {
    await chooseChatGPTLogin();
    await clickTestId("agent-network-provider-continue");
    await clickTestId("agent-network-provider-submit");
    await findText("WDJB-MJHT");
    await settle();
  },
};

export const EditChatGPT = editStory("ChatGPT team plan");

/* The Login column, one ChatGPT-login provider per state. */
const loginStates = {
  api: {
    "GET /agent-network/providers": [
      ...agentProviders.filter((p) => p.id !== "anp-chatgpt"),
      ...chatgptProvidersByLoginState,
    ],
  },
};

export const LoginStates: Story = {
  parameters: loginStates,
  play: async () => {
    await findText("ChatGPT support");
    await settle();
  },
};

export const LoginLinkDialog: Story = {
  parameters: loginStates,
  play: async () => {
    await findText("ChatGPT research");
    await clickRole("button", /^Link$/);
    await dialog();
    await findText("WDJB-MJHT");
    await settle();
  },
};

async function chooseClaudeLogin() {
  await pickProvider("Anthropic", "anthropic_api");
  await clickTestId("agent-network-provider-auth-login");
  await findText(/shares one Claude plan/);
  await settle();
}

export const ConnectModalClaudeLogin: Story = { play: chooseClaudeLogin };

export const ConnectModalClaudeModels: Story = {
  play: async () => {
    await chooseClaudeLogin();
    await clickTestId("agent-network-provider-models-tab");
    await settle();
  },
};

const claudeLoginAPI = {
  "GET /agent-network/providers": [
    ...agentProviders,
    ...claudeProvidersByLoginState,
  ],
  "POST /agent-network/providers/:id/link": claudeLinkFlow("pending"),
  "GET /agent-network/providers/:id/link/:flowId": claudeLinkFlow("pending"),
};

export const ConnectModalClaudeLinkPending: Story = {
  parameters: { api: claudeLoginAPI },
  play: async () => {
    await chooseClaudeLogin();
    await clickTestId("agent-network-provider-continue");
    await clickTestId("agent-network-provider-submit");
    await findText("Paste the code from the sign-in page");
    await settle();
  },
};

export const ClaudeLoginStates: Story = {
  parameters: { api: claudeLoginAPI },
  play: async () => {
    await findText("Claude support");
    await settle();
  },
};

export const EditClaude: Story = {
  ...editStory("Claude team plan"),
  parameters: { api: claudeLoginAPI },
};

async function openClaudeLink() {
  await findText("Claude research");
  await clickRole("button", /^Link$/);
  await dialog();
}

export const ClaudeLinkDialog: Story = {
  parameters: { api: claudeLoginAPI },
  play: async () => {
    await openClaudeLink();
    await findText("Paste the code from the sign-in page");
    await settle();
  },
};

export const ClaudeLinkComplete: Story = {
  parameters: { api: claudeLoginAPI },
  play: async () => {
    await openClaudeLink();
    await type(
      await waitForSelector(
        "[data-testid=agent-network-provider-authorization-code]",
      ),
      "storybook-code#storybook-state",
    );
    await clickRole("button", "Link login");
    await findText(/plan is linked/);
    await settle();
  },
};

export const ClaudeLinkExpired: Story = {
  parameters: {
    api: {
      ...claudeLoginAPI,
      "POST /agent-network/providers/:id/link": claudeLinkFlow("expired"),
    },
  },
  play: async () => {
    await openClaudeLink();
    await findText("The code expired before the login was approved.");
    await settle();
  },
};

export const ClaudeLinkFailed: Story = {
  parameters: {
    api: {
      ...claudeLoginAPI,
      "POST /agent-network/providers/:id/link": claudeLinkFlow("failed"),
    },
  },
  play: async () => {
    await openClaudeLink();
    await findText("Claude did not approve the login.");
    await settle();
  },
};
