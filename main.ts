import "make-promises-safe"
import { APIModalSubmitInteraction, Routes, TextInputStyle, Snowflake, APIActionRowComponent, APIMessageActionRowComponent } from "discord-api-types/v10"
import { Client, TextChannel, ButtonStyle, Message, InteractionResponseType, ComponentType, InteractionType, GatewayDispatchEvents, Events, ActionRowBuilder, ButtonBuilder, SlashCommandBuilder, REST, JSONEncodable, Attachment, AttachmentPayload } from "discord.js"
import pino from "pino"
import { resolve } from "path"
import config from "./config.json"
import { getIdFromUsername, getPlayerInfo, getPlayerThumbnail, PlayerInfo, PlayerThumbnailData } from "noblox.js"
import { AccountPlatform, ActionType, API, createAction } from "@free-draw/moderation-client"
import axios from "axios"

const log = pino()

if (process.env.NODE_ENV === "development") {
	require("dotenv").config({
		path: resolve(__dirname, ".env"),
	})
}

const env = process.env as {
	TOKEN: string,
	API_URL: string,
	API_TOKEN: string,
}

/* API */

const api = new API(
	env.API_URL,
	env.API_TOKEN
)

/* UTILS */

function encodeFragment(name: string, ...args: string[]): string {
	return `${name}(${args.join(",")})`
}

function decodeFragment(data: string): {
	name: string,
	args: string[],
} | null {
	const match = data.match(/^(\w+)\((.+)\)$/)

	if (!match) return null

	const name = match[1]
	const args = match[2].split(",")

	return { name, args }
}

async function downloadAttachment(attachment: Attachment): Promise<AttachmentPayload> {
	const attachmentFile = await axios.get(attachment.url, { responseType: "arraybuffer" })

	return {
		attachment: attachmentFile.data,
		name: attachment.name,
		description: attachment.description ?? undefined,
	}
}

/* DISCORD */

const rest = new REST({ version: "10" }).setToken(env.TOKEN)

const client = new Client({
	intents: [],
})

client.login(env.TOKEN).then(() => {
	log.info("Logged into Discord")
})

/* COMMAND */

const command = new SlashCommandBuilder()
	.setName("report")
	.setDescription("Creates a new report")
	.addStringOption((option) => {
		return option
			.setName("username")
			.setDescription("Roblox username of the offending user (i.e. @Reselim)")
			.setRequired(true)
	})
	.addStringOption((option) => {
		return option
			.setName("details")
			.setDescription("What is the offending user doing?")
			.setRequired(true)
	})
	.addAttachmentOption((option) => {
		return option
			.setName("attachment")
			.setDescription("An image or video showing proof of the offence (max 25MB)")
			.setRequired(true)
	})

client.on(Events.ClientReady, (async () => {
	log.info("Refreshing guild commands")

	await rest.put(
		Routes.applicationGuildCommands(client.user!.id, config.guild),
		{ body: [ command.toJSON() ] }
	)

	log.info("Successfully refreshed guild commands")
}))

/* INTERACTIONS */

client.on(Events.InteractionCreate, async (interaction) => {
	if (interaction.isChatInputCommand()) {
		if (interaction.commandName == command.name) {
			await interaction.deferReply({ ephemeral: true })

			// Options

			const username = interaction.options.getString("username", true)
			const details = interaction.options.getString("details", true)
			const attachment = interaction.options.getAttachment("attachment", true)

			if (attachment.size > 25_000_000) {
				interaction.editReply({
					content: `❌ **Error**: Attachment must be less than 25MB in size`,
				})

				return
			}

			// Fetch: User ID

			let id: number

			try {
				id = await getIdFromUsername(username)
			} catch {
				interaction.editReply({
					content: `❌ **Error**: Username "${username}" is invalid`,
				})

				return
			}

			// Fetch: Profile

			let info: PlayerInfo
			let thumbnail: PlayerThumbnailData | null

			try {
				info = await getPlayerInfo(id)

				const thumbnails = await getPlayerThumbnail([ id ], 180, "png", false, "headshot")
				if (thumbnails.length !== 0 && thumbnails[0].state === "Completed") {
					thumbnail = thumbnails[0]
				} else {
					thumbnail = null
				}
			} catch {
				interaction.editReply({
					content: `❌ **Error**: Failed to fetch user profile`,
				})

				return
			}

			// Send

			const guild = await client.guilds.fetch(config.guild)
			const channel = await guild.channels.fetch(config.channels.reports) as TextChannel

			await channel.send({
				content: [
					`from ${interaction.user.toString()}`,
					`> ${details}`,
					`**\n**`, // spacing hack
				].join("\n"),

				embeds: [
					{
						title: `${info.displayName} (@${info.username})`,
						url: `https://www.roblox.com/users/${id}/profile`,
						thumbnail: thumbnail ? thumbnail.imageUrl,
						description: info.blurb,
						color: 0xd32f2f,
						fields: [
							{ name: "Joined", value: `<t:${info.joinDate.getTime()}:f>`, inline: true },
						],
					},
				],

				files: [
					await downloadAttachment(attachment),
				],

				components: [
					new ActionRowBuilder().addComponents([
						new ButtonBuilder()
							.setCustomId(encodeFragment("accept", id.toString(), ActionType.BAN))
							.setLabel("Ban")
							.setStyle(ButtonStyle.Secondary),

						new ButtonBuilder()
							.setCustomId(encodeFragment("accept", id.toString(), ActionType.DRAWBAN))
							.setLabel("Draw-ban")
							.setStyle(ButtonStyle.Secondary),

						new ButtonBuilder()
							.setCustomId(encodeFragment("accept", id.toString(), ActionType.MUTE))
							.setLabel("Mute")
							.setStyle(ButtonStyle.Secondary),

						new ButtonBuilder()
							.setCustomId(encodeFragment("decline", id.toString()))
							.setLabel("Decline")
							.setStyle(ButtonStyle.Danger),
					]) as JSONEncodable<APIActionRowComponent<APIMessageActionRowComponent>> // ok
				],
			})

			interaction.editReply({
				content: "✅ Sent report!",
			})
		}
	}

	if (interaction.isMessageComponent()) {
		const fragment = decodeFragment(interaction.customId)
		if (!fragment) return

		const logsChannel = await client.channels.fetch(config.channels.logs) as TextChannel
		const reportsChannel = await client.channels.fetch(config.channels.reports) as TextChannel

		if (fragment.name === "accept") {
			const [ id, type ] = fragment.args

			// WORKAROUND: Modal
			await rest.post(
				Routes.interactionCallback(interaction.id, interaction.token),
				{
					body: {
						type: InteractionResponseType.Modal,
						data: {
							custom_id: encodeFragment("accept", id, type, interaction.message.id),
							title: `Accept Report — ${type}`,
							components: [
								{
									type: ComponentType.ActionRow,
									components: [
										{
											type: ComponentType.TextInput,
											style: TextInputStyle.Short,
											custom_id: "reason",
											label: "Reason",
											max_length: 50,
											required: true,
										},
									],
								},
								{
									type: ComponentType.ActionRow,
									components: [
										{
											type: ComponentType.TextInput,
											style: TextInputStyle.Paragraph,
											custom_id: "notes",
											label: "Notes",
											required: false,
										},
									],
								},
							],
						},
					},
				},
			)
		} else if (fragment.name === "decline") {
			const message = await reportsChannel.messages.fetch(interaction.message.id)

			if (message) {
				await message.delete()

				const initialMessage = interaction.message as Message
				const [ initialEmbed ] = initialMessage.embeds
				const [ initialMention ] = initialMessage.mentions.users.values()

				await logsChannel.send({
					embeds: [
						{
							title: "❌ Report Declined",
							description: `${interaction.user.toString()} declined a report from ${initialMention.toString()}`,
							fields: [
								{ name: "User", value: `[${initialEmbed.title}](${initialEmbed.url})` },
							],
							color: 0xd32f2f,
						},
					],

					files: await Promise.all(initialMessage.attachments.map(downloadAttachment)),
				})
			} else {
				await interaction.editReply({
					content: `❌ **Error**: Failed to find message with ID ${interaction.message.id}`
				})
			}
		}
	}
})

// WORKAROUND: Modal
client.ws.on("INTERACTION_CREATE" as unknown as GatewayDispatchEvents, async (data: APIModalSubmitInteraction) => {
	const discordUserId = (data.user?.id ?? data.member?.user.id)!

	if (data.type === InteractionType.ModalSubmit) {
		const fragment = decodeFragment(data.data.custom_id)
		if (!fragment) return

		if (fragment.name == "accept") {
			const [ id, type, messageId ] = fragment.args as [ string, ActionType, Snowflake ]

			// Parse options

			const options = {} as Record<string, string>
			data.data.components!.forEach((component) => {
				component.components.forEach((subComponent) => {
					if (subComponent.type === ComponentType.TextInput) {
						options[subComponent.custom_id] = subComponent.value
					}
				})
			})

			// Create action

			const identity = api.as({
				platform: AccountPlatform.DISCORD,
				id: discordUserId,
			})

			await createAction(identity, parseInt(id), {
				type: type,
				reason: options.reason,
				notes: options.notes,
			})

			// Fetch and delete message

			const reportsChannel = await client.channels.fetch(config.channels.reports) as TextChannel
			const logsChannel = await client.channels.fetch(config.channels.logs) as TextChannel

			const message = await reportsChannel.messages.fetch(messageId)
			await message.delete()

			// Create log

			const [ initialEmbed ] = message.embeds
			const [ initialMention ] = message.mentions.users.values()

			await logsChannel.send({
				embeds: [
					{
						title: "✅ Report Accepted",
						description: `<@${discordUserId}> accepted a report from ${initialMention.toString()}`,
						fields: [
							{ name: "User", value: `[${initialEmbed.title}](${initialEmbed.url})` },
						],
						color: 0x4caf50,
					},
				],

				files: await Promise.all(message.attachments.map(downloadAttachment)),
			})

			// Reply

			await rest.post(
				Routes.interactionCallback(data.id, data.token),
				{
					body: {
						type: InteractionResponseType.DeferredMessageUpdate,
					},
				}
			)
		}
	}
})
