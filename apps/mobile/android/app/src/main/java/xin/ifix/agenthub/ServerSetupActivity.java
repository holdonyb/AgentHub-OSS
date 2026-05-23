package xin.ifix.agenthub;

import android.content.Intent;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.appcompat.app.AppCompatActivity;

public class ServerSetupActivity extends AppCompatActivity {
    private EditText serverUrlInput;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setTitle("配置 AgentHub 服务器");
        setContentView(buildContentView());
        String existing = AgentHubServerConfig.loadServerUrl(this);
        if (existing != null) serverUrlInput.setText(existing);
    }

    private ScrollView buildContentView() {
        int spacing = dp(16);
        int inset = dp(20);

        ScrollView scrollView = new ScrollView(this);
        LinearLayout container = new LinearLayout(this);
        container.setOrientation(LinearLayout.VERTICAL);
        container.setPadding(inset, dp(32), inset, dp(24));
        container.setLayoutParams(new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        TextView title = new TextView(this);
        title.setText("先连接到你的 AgentHub");
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        container.addView(title);

        TextView summary = new TextView(this);
        summary.setText("先填写 AgentHub server URL，保存后再进入登录页面。你可以连接自己的本机、Tailscale 地址或 HTTPS 域名。");
        summary.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        summary.setPadding(0, dp(10), 0, 0);
        container.addView(summary);

        serverUrlInput = new EditText(this);
        serverUrlInput.setHint("https://agenthub.example.com");
        serverUrlInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        serverUrlInput.setSingleLine(true);
        LinearLayout.LayoutParams inputParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        inputParams.topMargin = spacing;
        serverUrlInput.setLayoutParams(inputParams);
        container.addView(serverUrlInput);

        TextView helper = new TextView(this);
        helper.setText(
            "示例：\n" +
            "• https://agenthub.example.com\n" +
            "• https://agenthub.tailnet-name.ts.net\n" +
            "• http://100.x.y.z:8019\n" +
            "• http://192.168.1.8:8019\n\n" +
            "规则：公网地址必须用 HTTPS；localhost、局域网和 Tailscale 地址允许 HTTP。"
        );
        helper.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        helper.setPadding(0, dp(12), 0, 0);
        container.addView(helper);

        Button saveButton = new Button(this);
        saveButton.setText("保存并继续");
        LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        buttonParams.topMargin = spacing;
        saveButton.setLayoutParams(buttonParams);
        saveButton.setOnClickListener(view -> saveAndContinue());
        container.addView(saveButton);

        TextView footer = new TextView(this);
        footer.setText("保存后应用会打开你填写的 AgentHub 站点，然后按正常流程登录。");
        footer.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        footer.setGravity(Gravity.CENTER_HORIZONTAL);
        footer.setPadding(0, dp(12), 0, 0);
        container.addView(footer);

        scrollView.addView(container);
        return scrollView;
    }

    private void saveAndContinue() {
        String input = serverUrlInput.getText() == null ? "" : serverUrlInput.getText().toString();
        try {
            AgentHubServerConfig.saveServerUrl(this, input);
        } catch (IllegalArgumentException error) {
            serverUrlInput.setError(error.getMessage());
            serverUrlInput.requestFocus();
            return;
        }
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(intent);
        finish();
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            value,
            getResources().getDisplayMetrics()
        ));
    }
}
